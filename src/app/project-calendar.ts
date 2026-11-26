import { z } from 'zod'
import { key, type OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { ProjectMessage } from '../sources/project-message.ts'
import type { Effects } from './effects.ts'
import { ProjectError, Projects } from './projects.ts'
import type { Store } from './store.ts'

const memberId = z.string().min(1).max(128)
export const CalendarEvent = z.strictObject({
  title: z.string().trim().min(1).max(160),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  inviteMemberIds: z.array(memberId).max(20),
}).refine(event => Date.parse(event.end) > Date.parse(event.start), '结束时间必须晚于开始时间')
type CalendarEvent = z.output<typeof CalendarEvent>
const eventId = z.string().regex(/^[\w+=./:@-]{1,256}$/)
export const CalendarTarget = z.strictObject({ eventId })
export const CalendarChange = CalendarTarget.extend({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(4000).optional(),
  start: z.iso.datetime({ offset: true }).optional(),
  end: z.iso.datetime({ offset: true }).optional(),
}).refine(({ title, description, start, end }) => (title !== undefined || description !== undefined || start !== undefined || end !== undefined)
  && (!start || !end || Date.parse(end) > Date.parse(start)), '请提供要修改的字段，并确认结束时间晚于开始时间')
export const CalendarInvite = CalendarTarget.extend({ inviteMemberIds: z.array(memberId).min(1).max(20) })
type CalendarAction = { kind: 'read' | 'cancel'; eventId: string } |
  ({ kind: 'update' } & z.output<typeof CalendarChange>) | ({ kind: 'invite' } & z.output<typeof CalendarInvite>)
type CalendarSnapshot = { title: string; start?: string; end?: string; roomCode?: string; status?: string }
const beijingTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' })
type CalendarContext = Pick<ProjectMessage, 'projectId' | 'actorId' | 'messageId' | 'channel' | 'mentions'>
export type CalendarRequest = CalendarContext & { organizer: string; attendees: string[]; corpId?: string } &
  ({ action?: undefined; event: CalendarEvent } | { action: CalendarAction; event?: undefined })
export type CalendarReceipt = { state: 'verified'; eventId: string; roomCode: string } |
  { state: 'created'; eventId: string } |
  { state: 'confirmed'; eventId: string; snapshot?: CalendarSnapshot } |
  { state: 'accepted'; eventId: string } | { state: 'rejected' | 'uncertain' }
export interface CalendarExecutor {
  corpId: string
  organizers: readonly string[]
  create(id: string, request: CalendarRequest, signal: AbortSignal): Promise<CalendarReceipt>
  manage?(id: string, request: Extract<CalendarRequest, { action: CalendarAction }>, signal: AbortSignal): Promise<CalendarReceipt>
  receipt(id: string, request?: CalendarRequest): Promise<CalendarReceipt>
}
export type CalendarAttempt = { request: CalendarRequest; state: 'queued' | 'started' | 'settled'; receipt?: CalendarReceipt; settledAt?: string }

/** A calendar write is queued in the project transaction and never repeated after it may have reached DingTalk. */
export class ProjectCalendar {
  private readonly projects: Projects

  constructor(private readonly store: Store, private readonly effects: Effects, private readonly executor: CalendarExecutor,
    private readonly notify: (message: OutboundMessage) => void, private readonly signal: AbortSignal,
    private readonly channelAllowed: (channel: ProjectMessage['channel']) => boolean, runnable: () => boolean) {
    this.projects = new Projects(store)
    effects.handle('project-calendar', (_, id) => this.run(id), { ordered: true, limit: () => runnable() ? 1 : 0 })
  }

  private authorize(context: CalendarContext, inviteMemberIds: readonly string[]) {
    const { corpId, organizers } = this.executor
    const { projectId, actorId, messageId, channel, mentions } = context
    const project = this.projects.detail(projectId)
    const trigger = this.store.triggers.get(messageId)
    if (!actorId || channel.source !== 'dingtalk' || !this.channelAllowed(channel) || channel.address.conversationId !== project.dingTalkGroup ||
      channel.address.triggerId !== messageId || !trigger?.human || trigger.source !== 'dingtalk' || trigger.actor.source !== 'dingtalk' ||
      trigger.channel?.thread !== channel.thread || trigger.meta.conversationId !== project.dingTalkGroup ||
      trigger.meta.senderCorpId !== corpId || !organizers.includes(trigger.actor.id) ||
      this.projects.memberForAccount(projectId, 'dingtalk', corpId, trigger.actor.id)?.id !== actorId)
      throw new ProjectError(403, '只有已获授权的钉钉项目成员可以为自己的日历创建会议。')

    const mentioned = new Set(mentions?.members.map(member => member.memberId) ?? [])
    if (mentions?.unresolvedCount || inviteMemberIds.some(id => !mentioned.has(id)))
      throw new ProjectError(400, '请在本条消息中明确 @ 每位参会的项目成员。')
    const attendees = [...new Set(inviteMemberIds)].sort().map(id => {
      const accounts = this.store.get(KV.projects.member(id))?.accounts.filter(account =>
        account.provider === 'dingtalk' && account.scope === corpId)
      if (!project.memberIds.includes(id) || accounts?.length !== 1)
        throw new ProjectError(400, '有参会者缺少可确认的企业钉钉账号。')
      return accounts[0]!.accountId
    })
    return { organizer: trigger.actor.id, attendees, corpId }
  }

  request(context: CalendarContext, event: CalendarEvent): string {
    const { projectId, actorId, messageId, channel, mentions } = context
    const id = key('project-calendar', projectId, messageId)
    if (this.store.get(KV.projects.calendarAttempt(id)))
      return '这条消息的日程请求已登记，请查看同一会话的处理回执。'
    if (Date.parse(event.start) <= Date.now()) throw new ProjectError(400, '请提供将来的会议开始时间。')
    const identities = this.authorize(context, event.inviteMemberIds)
    this.store.set(KV.projects.calendarAttempt(id), { state: 'queued',
      request: { projectId, actorId, messageId, channel, mentions, event, ...identities } })
    this.effects.enqueue('project-calendar', id, {})
    return '已提交钉钉日程创建请求。日程和会议号以随后收到的核验回执为准。'
  }

  meetings(context: CalendarContext, id?: string) {
    const { organizer } = this.authorize(context, [])
    const rows = this.store.db.prepare(`SELECT attempt.value FROM kv attempt
      LEFT JOIN trigger source ON source.id = json_extract(attempt.value, '$.request.messageId')
      WHERE attempt.key GLOB ? AND json_extract(attempt.value, '$.request.projectId') = ?
      AND json_extract(attempt.value, '$.request.organizer') = ?
      AND coalesce(json_extract(attempt.value, '$.request.corpId'), json_extract(source.value, '$.meta.senderCorpId')) = ?
      AND json_extract(attempt.value, '$.state') = 'settled'
      AND json_extract(attempt.value, '$.receipt.eventId') IS NOT NULL
      AND (? IS NULL OR json_extract(attempt.value, '$.receipt.eventId') = ?)
      ORDER BY json_extract(attempt.value, '$.settledAt') DESC, attempt.key`)
      .all(`${KV.projects.calendarAttempt.prefix}*`, context.projectId, organizer, this.executor.corpId, id ?? null, id ?? null)
    const records = rows.map(row => JSON.parse(String(row.value)) as CalendarAttempt)
    const snapshots = new Map<string, CalendarSnapshot>()
    for (const { receipt } of records)
      if (receipt?.state === 'confirmed' && receipt.snapshot?.title && !snapshots.has(receipt.eventId))
        snapshots.set(receipt.eventId, receipt.snapshot)
    const meetings = records.flatMap(({ receipt, request }) => {
      if (!receipt || !request.event || !('eventId' in receipt)) return []
      const snapshot = snapshots.get(receipt.eventId)
      return [{ eventId: receipt.eventId, title: snapshot?.title || request.event.title,
        start: snapshot?.start ?? request.event.start, end: snapshot?.end ?? request.event.end,
        roomCode: snapshot?.roomCode ?? (receipt.state === 'verified' ? receipt.roomCode : undefined) }]
    })
    const cancelled = new Set(records.flatMap(({ receipt, request }) =>
      request.action?.kind === 'cancel' && receipt?.state === 'confirmed' ? [receipt.eventId] : []))
    return meetings.sort((a,b) => Date.parse(b.start) - Date.parse(a.start)).slice(0, 20)
      .map(meeting => ({ ...meeting, cancelled: cancelled.has(meeting.eventId) }))
  }

  manage(context: CalendarContext, action: CalendarAction): string {
    if (!this.executor.manage) throw new ProjectError(409, '当前部署未启用日程管理。')
    const { projectId, actorId, messageId, channel, mentions } = context
    const identities = this.authorize(context, action.kind === 'invite' ? action.inviteMemberIds : [])
    if (!this.meetings(context, action.eventId).some(meeting => !meeting.cancelled || action.kind === 'read' || action.kind === 'cancel'))
      throw new ProjectError(404, '在当前项目和你的日历记录里找不到可操作的日程。请先查找已有日程并确认目标。')
    const id = key('project-calendar', projectId, messageId, action.kind)
    if (this.store.get(KV.projects.calendarAttempt(id))) return '这条消息的同类日程请求已登记，请查看回执。'
    this.store.set(KV.projects.calendarAttempt(id), { state: 'queued',
      request: { projectId, actorId, messageId, channel, mentions, action, ...identities } })
    this.effects.enqueue('project-calendar', id, {})
    return '已登记日程操作，请查看随后的钉钉回执。'
  }

  private async run(id: string) {
    const entry = this.store.get(KV.projects.calendarAttempt(id))
    if (!entry || entry.state === 'settled') return
    const { request } = entry
    const action = request.action
    let receipt: CalendarReceipt = { state: 'uncertain' }
    if (entry.state === 'started') {
      receipt = await this.executor.receipt(id, request).catch(() => receipt)
    } else {
      try {
        const invitees = request.event?.inviteMemberIds ?? (action?.kind === 'invite' ? action.inviteMemberIds : [])
        const identities = this.authorize(request, invitees)
        const targetAllowed = !action || this.meetings(request, action.eventId).some(meeting =>
          !meeting.cancelled || action.kind === 'read' || action.kind === 'cancel')
        if (identities.organizer !== request.organizer || request.corpId && identities.corpId !== request.corpId ||
          identities.attendees.join('\0') !== request.attendees.join('\0') ||
          request.event && Date.parse(request.event.start) <= Date.now() || !targetAllowed || this.signal.aborted) throw new Error()
      } catch {
        this.settle(id, request, { state: 'rejected' }, '请求已失效，请重新确认时间及日程授权。')
        return
      }
      this.store.set(KV.projects.calendarAttempt(id), { ...entry, state: 'started' })
      const effect = request.action ? this.executor.manage?.(id, request, this.signal) : this.executor.create(id, request, this.signal)
      if (effect) receipt = await effect.catch(() => receipt)
    }
    this.signal.throwIfAborted()
    this.settle(id, request, receipt)
  }

  private settle(id: string, request: CalendarRequest, receipt: CalendarReceipt, message?: string) {
    const text = message ?? this.resultMessage(request, receipt)
    this.store.atomic(() => {
      this.store.set(KV.projects.calendarAttempt(id), { state: 'settled', request, receipt, settledAt: new Date().toISOString() })
      this.notify({ id: key('project-calendar-result', id), channel: request.channel, kind: 'notice', text,
        origin: { projectId: request.projectId, eventId: request.messageId } })
    })
  }

  private resultMessage(request: CalendarRequest, receipt: CalendarReceipt): string {
    if (request.event && receipt.state === 'verified') {
      const { title, start, end } = request.event
      return `已创建并核验钉钉日程「${title}」。\n${beijingTime.formatRange(new Date(start), new Date(end))}（北京时间）\n会议号：${receipt.roomCode}`
    }
    if (request.action && receipt.state === 'confirmed') {
      const snapshot = receipt.snapshot
      const title = snapshot?.title ? `「${snapshot.title}」` : ''
      const details = snapshot ? [
        snapshot.start && snapshot.end ? `${beijingTime.formatRange(new Date(snapshot.start), new Date(snapshot.end))}（北京时间）` : '',
        snapshot.status === 'cancelled' ? '状态：已取消' : '',
        snapshot.roomCode ? `会议号：${snapshot.roomCode}` : '',
      ].filter(Boolean) : []
      const action = { read: '已查询日程', update: '已修改并核验日程', cancel: '已取消并核验日程', invite: '已添加并核验参会人' }
      return [`${action[request.action.kind]}${title}。`, ...details].join('\n')
    }
    if (receipt.state === 'created' || receipt.state === 'accepted') {
      const detail = receipt.state === 'created' ? '会议号尚未核验' : '变更尚未读回核验'
      return `钉钉已接受对日程 ${receipt.eventId} 的操作，${detail}。请先核对日历。`
    }
    if (receipt.state === 'rejected') return '钉钉日程操作未执行或被拒绝，请检查日程状态、时间或接口权限。'
    return request.action?.kind === 'read' ? '暂时无法读取钉钉日程。' : '暂时无法确认操作结果。请先在钉钉日历核对，避免重复提交。'
  }

}

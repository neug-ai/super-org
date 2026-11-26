import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { ProjectMessage } from '../sources/project-message.ts'
import type { Effects } from './effects.ts'
import { ProjectError, Projects, type Member, type Project } from './projects.ts'
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
export type CalendarContext = Pick<ProjectMessage, 'projectId' | 'actorId' | 'messageId' | 'channel' | 'mentions'>
export type CalendarRequest = CalendarContext & { organizer: string; attendees: string[]; provider?: string; scope?: string; corpId?: string } &
  ({ action?: undefined; event: CalendarEvent } | { action: CalendarAction; event?: undefined })
export type CalendarReceipt = { state: 'verified'; eventId: string; roomCode?: string } |
  { state: 'created'; eventId: string } |
  { state: 'confirmed'; eventId: string; snapshot?: CalendarSnapshot } |
  { state: 'accepted'; eventId: string } | { state: 'rejected' | 'uncertain' }
export interface CalendarExecutor {
  provider: string
  label: string
  timeZone?: string
  organizer(context: CalendarContext, project: Project, trigger: Trigger | undefined, member: Member): { id: string; scope: string } | undefined
  attendee(member: Member, scope: string): string | undefined
  legacyScope?(trigger?: Trigger): string | undefined
  create(id: string, request: CalendarRequest, signal: AbortSignal): Promise<CalendarReceipt>
  manage?(id: string, request: Extract<CalendarRequest, { action: CalendarAction }>, signal: AbortSignal): Promise<CalendarReceipt>
  receipt(id: string, request?: CalendarRequest): Promise<CalendarReceipt>
}
export type CalendarAttempt = { request: CalendarRequest; state: 'queued' | 'started' | 'settled'; receipt?: CalendarReceipt; settledAt?: string }

/** A calendar write is queued in the project transaction and never repeated after it may have reached the provider. */
export class ProjectCalendar {
  private readonly projects: Projects

  constructor(private readonly store: Store, private readonly effects: Effects, private readonly executors: readonly CalendarExecutor[],
    private readonly notify: (message: OutboundMessage) => void, private readonly signal: AbortSignal,
    private readonly channelAllowed: (channel: ProjectMessage['channel']) => boolean, runnable: () => boolean) {
    this.projects = new Projects(store)
    effects.handle('project-calendar', (_, id) => this.run(id), { ordered: true, limit: () => runnable() ? 1 : 0 })
  }

  private executor(source: string) {
    return this.executors.find(item => item.provider === source)
  }

  available(context: CalendarContext, manage = false): boolean {
    try {
      const { executor } = this.authorize(context, [])
      return !manage || !!executor.manage
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      return false
    }
  }

  private authorize(context: CalendarContext, inviteMemberIds: readonly string[]) {
    const { projectId, actorId, messageId, channel, mentions } = context
    const project = this.projects.detail(projectId)
    const executor = this.executor(channel.source)
    const trigger = this.store.triggers.get(messageId)
    const member = project.members.find(item => item.id === actorId)
    const principal = executor && member && project.status !== 'archived' && this.channelAllowed(channel)
      ? executor.organizer(context, project, trigger, member) : undefined
    if (!executor || !principal)
      throw new ProjectError(403, '只有已获授权的项目成员可以操作这个会话对应的日历。')

    const mentioned = new Set(mentions?.members.map(member => member.memberId) ?? [])
    if (inviteMemberIds.length && (mentions?.unresolvedCount || inviteMemberIds.some(id => !mentioned.has(id))))
      throw new ProjectError(400, '请在本条消息中明确 @ 每位参会的项目成员。')
    const attendees = [...new Set(inviteMemberIds)].sort().map(id => {
      const invitee = project.members.find(item => item.id === id)
      const account = invitee && executor.attendee(invitee, principal.scope)
      if (!account) throw new ProjectError(400, '有参会者缺少可确认的日历账号。')
      return account
    })
    return { executor, identities: { provider: executor.provider, organizer: principal.id, scope: principal.scope, attendees } }
  }

  request(context: CalendarContext, event: CalendarEvent): string {
    const { projectId, actorId, messageId, channel, mentions } = context
    const { executor, identities } = this.authorize(context, event.inviteMemberIds)
    const id = key('project-calendar', projectId, messageId)
    const pending = `正在创建${executor.label}日程。结果以日历回执为准。`
    if (this.store.get(KV.projects.calendarAttempt(id))) return pending
    if (Date.parse(event.start) <= Date.now()) throw new ProjectError(400, '请提供将来的会议开始时间。')
    this.store.set(KV.projects.calendarAttempt(id), { state: 'queued',
      request: { projectId, actorId, messageId, channel, mentions, event, ...identities } })
    this.effects.enqueue('project-calendar', id, {})
    return pending
  }

  meetings(context: CalendarContext, id?: string) {
    const { executor, identities: { organizer, scope } } = this.authorize(context, [])
    const rows = this.store.db.prepare(`SELECT attempt.value, source.value AS trigger FROM kv attempt
      LEFT JOIN trigger source ON source.id = json_extract(attempt.value, '$.request.messageId')
      WHERE attempt.key GLOB ? AND json_extract(attempt.value, '$.request.projectId') = ?
      AND json_extract(attempt.value, '$.request.organizer') = ?
      AND coalesce(json_extract(attempt.value, '$.request.provider'), json_extract(attempt.value, '$.request.channel.source')) = ?
      AND json_extract(attempt.value, '$.state') = 'settled'
      AND json_extract(attempt.value, '$.receipt.eventId') IS NOT NULL
      AND (? IS NULL OR json_extract(attempt.value, '$.receipt.eventId') = ?)
      ORDER BY json_extract(attempt.value, '$.settledAt') DESC, attempt.key`)
      .all(`${KV.projects.calendarAttempt.prefix}*`, context.projectId, organizer, executor.provider, id ?? null, id ?? null)
    const records = rows.flatMap(row => {
      const attempt = JSON.parse(String(row.value)) as CalendarAttempt
      const savedScope = attempt.request.scope ?? attempt.request.corpId ?? executor.legacyScope?.(
        typeof row.trigger === 'string' ? JSON.parse(row.trigger) as Trigger : undefined)
      return savedScope === scope ? [attempt] : []
    })
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
    const { projectId, actorId, messageId, channel, mentions } = context
    const { executor, identities } = this.authorize(context, action.kind === 'invite' ? action.inviteMemberIds : [])
    if (!executor.manage) throw new ProjectError(409, '当前提供者未启用日程管理。')
    if (!this.meetings(context, action.eventId).some(meeting => !meeting.cancelled || action.kind === 'read' || action.kind === 'cancel'))
      throw new ProjectError(404, '在当前项目和你的日历记录里找不到可操作的日程。请先查找已有日程并确认目标。')
    const id = key('project-calendar', projectId, messageId, action.kind)
    const verb = { read: '查询', update: '修改', cancel: '取消', invite: '添加参会人到' }[action.kind]
    const pending = `正在${verb}${executor.label}日程。`
    if (this.store.get(KV.projects.calendarAttempt(id))) return pending
    this.store.set(KV.projects.calendarAttempt(id), { state: 'queued',
      request: { projectId, actorId, messageId, channel, mentions, action, ...identities } })
    this.effects.enqueue('project-calendar', id, {})
    return pending
  }

  private async run(id: string) {
    const entry = this.store.get(KV.projects.calendarAttempt(id))
    if (!entry || entry.state === 'settled') return
    const { request } = entry
    const action = request.action
    const executor = this.executor(request.provider ?? request.channel.source)
    if (!executor) {
      this.settle(id, request, { state: entry.state === 'started' ? 'uncertain' : 'rejected' }, '日历提供者已停用，请在对应日历核对。')
      return
    }
    let receipt: CalendarReceipt = { state: 'uncertain' }
    if (entry.state === 'started') {
      receipt = await executor.receipt(id, request).catch(() => receipt)
    } else {
      try {
        const invitees = request.event?.inviteMemberIds ?? (action?.kind === 'invite' ? action.inviteMemberIds : [])
        const { identities } = this.authorize(request, invitees)
        const targetAllowed = !action || this.meetings(request, action.eventId).some(meeting =>
          !meeting.cancelled || action.kind === 'read' || action.kind === 'cancel')
        if (identities.organizer !== request.organizer || (request.scope ?? request.corpId ?? executor.legacyScope?.(this.store.triggers.get(request.messageId))) !== identities.scope ||
          identities.attendees.join('\0') !== request.attendees.join('\0') ||
          request.event && Date.parse(request.event.start) <= Date.now() || !targetAllowed || this.signal.aborted) throw new Error()
      } catch {
        this.settle(id, request, { state: 'rejected' }, '请求已失效，请重新确认时间及日程授权。')
        return
      }
      this.store.set(KV.projects.calendarAttempt(id), { ...entry, state: 'started' })
      const effect = request.action ? executor.manage?.(id, request, this.signal) : executor.create(id, request, this.signal)
      if (effect) receipt = await effect.catch(() => receipt)
    }
    this.signal.throwIfAborted()
    this.settle(id, request, receipt)
  }

  private settle(id: string, request: CalendarRequest, receipt: CalendarReceipt, message?: string) {
    const text = message ?? this.resultMessage(request, receipt)
    this.store.atomic(() => {
      this.store.set(KV.projects.calendarAttempt(id), { state: 'settled', request, receipt, settledAt: new Date().toISOString() })
      const channel = { ...request.channel, address: { ...request.channel.address, projectNotice: 'true' } }
      this.notify({ id: key('project-calendar-result', id), channel, kind: 'notice', text,
        origin: { projectId: request.projectId, eventId: request.messageId,
          runId: key('project-agent', request.channel.source, request.messageId) } })
    })
  }

  private resultMessage(request: CalendarRequest, receipt: CalendarReceipt): string {
    const provider = this.executor(request.provider ?? request.channel.source)
    const label = provider?.label ?? ''
    const timeZone = provider?.timeZone ?? 'UTC'
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium', timeStyle: 'short' })
    const range = (start: string, end: string) => `${time.formatRange(new Date(start), new Date(end))}（${timeZone === 'Asia/Shanghai' ? '北京时间' : timeZone}）`
    if (request.event && receipt.state === 'verified') {
      const { title, start, end } = request.event
      return `已创建并核验${label}日程「${title}」。\n${range(start, end)}${receipt.roomCode ? `\n会议号：${receipt.roomCode}` : ''}`
    }
    if (request.action && receipt.state === 'confirmed') {
      const snapshot = receipt.snapshot
      const title = snapshot?.title ? `「${snapshot.title}」` : ''
      const details = snapshot ? [
        snapshot.start && snapshot.end ? `${range(snapshot.start, snapshot.end)}` : '',
        snapshot.status === 'cancelled' ? '状态：已取消' : '',
        snapshot.roomCode ? `会议号：${snapshot.roomCode}` : '',
      ].filter(Boolean) : []
      const action = { read: '已查询日程', update: '已修改并核验日程', cancel: '已取消并核验日程', invite: '已添加并核验参会人' }
      return [`${action[request.action.kind]}${title}。`, ...details].join('\n')
    }
    if (receipt.state === 'created' || receipt.state === 'accepted') {
      const detail = receipt.state === 'created' ? '会议号尚未核验' : '变更尚未读回核验'
      return `${label}已接受对日程 ${receipt.eventId} 的操作，${detail}。请先核对日历。`
    }
    if (receipt.state === 'rejected') return `${label}日程操作未执行或被拒绝，请检查日程状态、时间或接口权限。`
    return request.action?.kind === 'read' ? `暂时无法读取${label}日程。` : '暂时无法确认操作结果。请先在对应日历核对，避免重复提交。'
  }

}

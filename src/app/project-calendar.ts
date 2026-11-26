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
const beijingTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' })
type CalendarContext = Pick<ProjectMessage, 'projectId' | 'actorId' | 'messageId' | 'channel' | 'mentions'>
export type CalendarRequest = CalendarContext & { event: CalendarEvent; organizer: string; attendees: string[] }
export type CalendarReceipt = { state: 'verified'; eventId: string; roomCode: string } |
  { state: 'created'; eventId: string } | { state: 'rejected' | 'uncertain' }
export interface CalendarExecutor {
  corpId: string
  organizers: readonly string[]
  create(id: string, request: CalendarRequest, signal: AbortSignal): Promise<CalendarReceipt>
  receipt(id: string): Promise<CalendarReceipt>
}
export type CalendarAttempt = { request: CalendarRequest; state: 'queued' | 'started' | 'settled'; receipt?: CalendarReceipt }

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
    return { organizer: trigger.actor.id, attendees }
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

  private async run(id: string) {
    const entry = this.store.get(KV.projects.calendarAttempt(id))
    if (!entry || entry.state === 'settled') return
    const { request } = entry
    let receipt: CalendarReceipt = { state: 'uncertain' }
    if (entry.state === 'started') {
      receipt = await this.executor.receipt(id).catch(() => receipt)
    } else {
      try {
        const identities = this.authorize(request, request.event.inviteMemberIds)
        if (identities.organizer !== request.organizer || identities.attendees.join('\0') !== request.attendees.join('\0') ||
          Date.parse(request.event.start) <= Date.now() || this.signal.aborted) throw new Error()
      } catch {
        this.settle(id, request, { state: 'rejected' }, '请求已失效，请重新确认时间及日程授权。')
        return
      }
      this.store.set(KV.projects.calendarAttempt(id), { ...entry, state: 'started' })
      receipt = await this.executor.create(id, request, this.signal).catch(() => receipt)
    }
    this.signal.throwIfAborted()
    this.settle(id, request, receipt)
  }

  private settle(id: string, request: CalendarRequest, receipt: CalendarReceipt, message?: string) {
    const { title, start, end } = request.event
    const text = message ?? (receipt.state === 'verified' ?
      `已创建并核验钉钉日程「${title}」。\n${beijingTime.formatRange(new Date(start), new Date(end))}（北京时间）\n会议号：${receipt.roomCode}` :
      receipt.state === 'created' ? `钉钉已返回日程 ID ${receipt.eventId}，会议号尚未核验。请先在日历核对，再决定后续操作。` :
      receipt.state === 'rejected' ? '钉钉日程创建未完成，请联系部署管理员检查日程执行配置或接口权限。' :
      '暂时无法确认日程是否已创建。请先在钉钉日历核对，避免重复创建。')
    this.store.atomic(() => {
      this.store.set(KV.projects.calendarAttempt(id), { state: 'settled', request, receipt })
      this.notify({ id: key('project-calendar-result', id), channel: request.channel, kind: 'notice', text,
        origin: { projectId: request.projectId, eventId: request.messageId } })
    })
  }
}

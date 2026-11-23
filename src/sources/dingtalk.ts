/** dingtalk data source: configuration, normalization, context, transport and lifecycle. */
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { type SourceContext } from './host.ts'
import { type ProjectPlanning } from '../app/project-planning.ts'
import { type ProjectAgent } from '../app/project-agent.ts'
import type { Projects } from '../app/projects.ts'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { z } from 'zod'
import { type SourceKind } from './kind.ts'
import { projectMessageReceived, type MessageAttachment, type ProjectMessage } from './project-message.ts'
import { DingTalkCards } from './dingtalk-cards.ts'
import { AttachmentReadError, maxAttachmentBytes } from '../app/attachment-text.ts'

// dingtalk-projects: provider implementation
function sender(trigger: Trigger) {
  const corpId = trigger.meta.senderCorpId
  const name = typeof trigger.meta.senderNick === 'string' ? trigger.meta.senderNick : `钉钉成员 ${trigger.actor.id.slice(-6)}`
  return { corpId: typeof corpId === 'string' && corpId.length <= 128 && trigger.actor.id.length <= 128 ? corpId : undefined, name }
}
function enrollmentIntent(text: string): 'self' | 'help' | undefined {
  const message = text.replace(/[。！？!?]+$/u, '').trim()
  if (/^(?:登记项目成员|(?:请)?(?:帮我|给我|把我|将我)\s*(?:登记(?:加入(?:项目)?|为(?:本|这个)?项目成员)?|加入(?:本|这个)?项目)|我要(?:登记(?:为)?项目成员|加入(?:本|这个)?项目))$/u.test(message)) return 'self'
  if (/^(?:请问[，,：:\s]*)?(?:(?:这个群|本群|群里)的?成员|项目成员|群成员)?\s*(?:如何|怎么|怎样)(?:登记(?:为?项目成员)?(?:上来)?|加入(?:本|这个)?项目)(?:呢|呀|吗)?$/u.test(message)) return 'help'
}
function enrollmentHelp(project?: DingTalkIntake['project']): string {
  const action = '每位群成员可以 @ 我发「登记项目成员」，也可以发「把我登记加入」。'
  return action + (project ? '我会用发消息的钉钉账号把本人加入这个群绑定的项目。'
    : '这个群还没有绑定项目，我会先把本人登记到成员目录，之后可提交首次项目纪要。')
}
/** Only a designated intake group may open a project before it has a saved binding. */
export function dingTalkProjectIntake(projects: Projects, planning?: ProjectPlanning, intakeGroup?: string, agent?: ProjectAgent): DingTalkIntake {
  return { conversationId: intakeGroup, forConversation: group => {
    if (!planning) return
    const project = projects.forDingTalkGroup(group)
    if (project) return { ...dingTalkProjects(group, project.id, projects, planning, agent), project }
    if (group !== intakeGroup) return
    return {
      onSender: (trigger: Trigger) => {
        const { corpId, name } = sender(trigger)
        if (!corpId) return
        const { added } = projects.registerDingTalkSender(corpId, trigger.actor.id, name)
        return added ? '已登记你的成员账号。团队讨论后可以提交首次项目纪要。' : '你的成员账号已登记。'
      },
      onMeeting: (trigger: Trigger) => {
        if (trigger.text.length > 26_000) return '会议纪要超过 26,000 字，请缩短后重发。'
        const { corpId, name } = sender(trigger)
        const member = corpId && projects.directoryMemberForAccount('dingtalk', corpId, trigger.actor.id)
        if (!member) return '请先 @ 我发「登记项目成员」，再提交会议纪要。'
        const names = [...trigger.text.matchAll(/^项目名称[：:][ \t]*(.*)$/gm)]
        const projectName = names[0]?.[1]?.trim()
        if (names.length !== 1 || !projectName || projectName.length > 200) return '团队确认项目名称后，请在纪要里保留一行「项目名称：…」。'
        const repositories = [...trigger.text.matchAll(/^GitHub 仓库[：:][ \t]*(.*)$/gim)]
        const raw = repositories[0]?.[1]?.trim()
        if (repositories.length > 1) return '如果会议已确定 GitHub 仓库，请在同一行填写一个 owner/repo 或 GitHub 仓库链接。'
        try { planning.submitFirstMinutes({ name: projectName, repository: raw && raw !== '无' ? raw : null, dingTalkGroup: group }, {
          ...meetingEvidence(trigger, name, member.id), text: trigger.text, channel: trigger.channel,
          clarificationHint: '补充时请 @ 我发「会议反馈：…」。',
        }) } catch (error) {
          if (error instanceof z.ZodError) return '如果会议已确定 GitHub 仓库，请在同一行填写一个 owner/repo 或 GitHub 仓库链接。'
          throw error
        }
        return `已建立「${projectName}」，当前待开工。正在整理本次会议的分工。`
      },
    }
  } }
}
function meetingEvidence(trigger: Trigger, name: string, memberId?: string) {
  return { triggerId: trigger.id, source: trigger.source, name, at: trigger.at, memberId,
    messageId: typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined }
}
export function dingTalkProjects(conversationId: string, projectId: string, projects: Projects, planning: ProjectPlanning, agent?: ProjectAgent): DingTalkIntake {
  const enrollFirst = '请先在项目群里 @ 我发送「登记项目成员」。'
  const evidence = (trigger: Trigger) => {
    const { corpId, name } = sender(trigger)
    const member = corpId ? projects.memberForAccount(projectId, 'dingtalk', corpId, trigger.actor.id) : undefined
    return meetingEvidence(trigger, name, member?.id)
  }
  const meetingMessage = (trigger: Trigger, text = trigger.text) => ({ ...evidence(trigger), projectId, text,
    channel: trigger.channel, clarificationHint: '补充时请 @ 我发「会议反馈：…」。' })
  const manage = (trigger: Trigger) => {
    const { memberId } = evidence(trigger)
    if (!memberId) return enrollFirst
    if (!trigger.channel || !agent) return '项目消息通道尚未就绪。'
    const { corpId } = sender(trigger)
    const mentions = new Map<string, { memberId: string; name: string }>()
    let unresolvedCount = 0
    const mentionedStaffIds = trigger.meta.mentionedStaffIds
    if (corpId && Array.isArray(mentionedStaffIds)) {
      for (const staffId of mentionedStaffIds) {
        const member = typeof staffId === 'string' ? projects.directoryMemberForAccount('dingtalk', corpId, staffId) : undefined
        if (member) mentions.set(member.id, { memberId: member.id, name: member.name })
        else unresolvedCount++
      }
    }
    const attachments = Array.isArray(trigger.meta.attachments) ? trigger.meta.attachments as MessageAttachment[] : undefined
    const result = agent.submit({ projectId, actorId: memberId, messageId: trigger.id, channel: trigger.channel,
      text: trigger.text, quoted: typeof trigger.meta.replyToBotText === 'string' ? trigger.meta.replyToBotText : '',
      sentAt: trigger.at, nativeMessageId: typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined,
      replyToNativeMessageId: typeof trigger.meta.replyToMessageId === 'string' ? trigger.meta.replyToMessageId : undefined,
      ...(attachments?.length && { attachments }),
      ...(mentions.size || unresolvedCount ? { mentions: { members: [...mentions.values()], unresolvedCount } } : {}) })
    return result.status === 'disabled' ? '项目消息处理已关闭，可在事件配置中开启。' : '已收到，正在结合项目现状处理。'
  }
  const enroll = (trigger: Trigger) => {
    const { corpId, name } = sender(trigger)
    if (!corpId) return
    const { projectName, added } = projects.addDingTalkSender(projectId, corpId, trigger.actor.id, name)
    return added ? `已加入「${projectName}」项目。` : `你已是「${projectName}」的项目成员。`
  }
  return {
    conversationId,
    onSender: enroll,
    onStored: enroll,
    onMeeting: trigger => {
      if (agent) return manage(trigger)
      if (trigger.text.length > 26_000) return '会议纪要超过 26,000 字，请缩短后重发。'
      const meeting = planning.submitMinutes(meetingMessage(trigger))
      return meeting ? `已收到「${meeting.name}」会议纪要，正在把已确认的行动整理到看板。` : enrollFirst
    },
    discussion: trigger => {
      if (agent) return () => manage(trigger)
      const { name, status, meeting } = projects.meetingStatus(projectId)
      const explicit = /^会议反馈[：:]/u.test(trigger.text)
      const quote = typeof trigger.meta.replyToMessageId === 'string' && projects.detail(projectId).decisions
        .find(item => item.meetingSource?.messageId === trigger.meta.replyToMessageId)
      if (!meeting || !(explicit || quote || status === 'planning')) return
      return () => {
        const text = trigger.text.replace(/^会议反馈[：:]\s*/u, '').trim()
        if (!text) return '请在「会议反馈」后附上具体意见。'
        const result = planning.recordFeedback(meetingMessage(trigger, text.slice(0, 8000)), (quote || meeting).id, explicit || !!quote)
        if (result === 'membership-required') return enrollFirst
        if (result === 'queued') return `已收到补充，正在继续整理「${name}」的行动项。`
        return `已记入「${name}」的会议讨论。`
      }
    },
  }
}

// dingtalk: provider implementation
export const dingTalkRoute = family<Route, [string]>('dingtalk-route:')
const tickets = family<string, [string, string]>('dingtalk-ticket:')
const bodies = family<{ messageType: string; content: unknown }, [string]>('dingtalk-body:')
const NativeFile = z.object({ fileName: z.string().trim().min(1).max(300), downloadCode: z.string().min(1).max(4000), fileId: z.string().optional() })

function nativeFile(conversation: string, messageId: string, payload: { messageType: string; content: unknown }) {
  const content = payload.content
  const envelope = content && typeof content === 'object' && 'quote' in content
    ? QuotedMessage.safeParse(content.quote).data : undefined
  const quote = envelope?.msgType === 'file' && envelope.msgId ? envelope : undefined
  if (!quote && payload.messageType !== 'file') return
  let value = quote ? quote.content : envelope && content && typeof content === 'object' && 'content' in content ? content.content : content
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return }
  }
  const parsed = NativeFile.safeParse(value)
  if (!parsed.success) return
  const { fileName, downloadCode, fileId } = parsed.data
  const nativeMessageId = (quote?.msgId ?? messageId).trim()
  if (!nativeMessageId || nativeMessageId.length > 300) return
  return { descriptor: { id: key('dingtalk-file', conversation, nativeMessageId, fileId ?? fileName),
    name: fileName, nativeMessageId }, downloadCode }
}
const senderIdentities = family<string | null, [string]>('dingtalk-sender-identity:')
const optionalIdentity = z.string().min(1).max(256).optional()
const AtUser = z.object({ dingtalkId: optionalIdentity, staffId: z.string().min(1).max(128).optional() })
const deliveries = family<{ messageId: string; format: string; transport: string; messageType: string; at: string }, [string]>('dingtalk-last-delivery:')
const Message = z.object({ msgId: z.string().min(1), conversationId: z.string().min(1),
  conversationType: z.string(), isInAtList: z.boolean().optional(), senderStaffId: z.string().min(1),
  senderCorpId: z.string().min(1), senderNick: z.string().optional(), chatbotUserId: z.string().optional(), senderId: z.string().optional(),
  robotCode: z.string().min(1), msgtype: z.string(), text: z.object({ content: z.string().optional() }).nullish(),
  content: z.unknown().optional(), atUsers: z.unknown().optional(),
  createAt: z.number().optional(), sessionWebhook: z.string().url(), sessionWebhookExpiredTime: z.number() })
export interface Route { webhook: string; expires: number; robotCode: string; conversationId: string; corpId?: string }
export const ticketReference = (text: string): string | undefined => /(?:^|\s)#([a-f0-9]{12,32})(?=\s|$|[，。,:：])/i.exec(text)?.[1]?.toLowerCase()
export const label = (id: string): string => `#${id.slice(0, 12)}`
/** Projects the platform's body into text without treating a wire-format type as an admission rule. */
function contentText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? contentText(parsed) : value
    } catch { return value }
  }
  if (Array.isArray(value)) return value.map(contentText).join('')
  if (!value || typeof value !== 'object') return ''
  const body = value as Record<string, unknown>
  if (Array.isArray(body.richText)) return contentText(body.richText)
  if (typeof body.text === 'string') return body.text
  if (body.text && typeof body.text === 'object') return contentText(body.text)
  if (typeof body.content === 'string') return body.content
  if (typeof body.recognition === 'string') return body.recognition
  if (typeof body.unknownMsgType === 'string') return body.unknownMsgType
  if (body.type === 'br') return '\n'
  if (body.type === 'picture' || body.pictureDownloadCode) return '\n[图片附件，内容尚未下载或解析]\n'
  if (typeof body.fileName === 'string') return `[文件附件：${body.fileName}，内容尚未下载或解析]`
  return ''
}
const QuotedMessage = z.object({ msgId: z.string().optional(), senderId: z.string().optional(),
  msgType: z.string().optional(), content: z.unknown().optional() })
function quotedMessage(head: Record<string, unknown>) {
  for (let container of [head.text, head.content]) {
    if (typeof container === 'string') {
      try { container = JSON.parse(container) } catch { continue }
    }
    if (!container || typeof container !== 'object') continue
    const body = container as Record<string, unknown>
    if (body.isReplyMsg !== true) continue
    const quote = QuotedMessage.safeParse(body.repliedMsg)
    if (quote.success) return quote.data
  }
}
/** Only card TEXT nodes are readable quote content; opaque/encrypted content is never guessed. */
function quotedText(value: unknown, depth = 0): string {
  if (depth > 8) return ''
  if (typeof value === 'string') {
    try { return quotedText(JSON.parse(value), depth + 1) } catch { return value }
  }
  if (Array.isArray(value)) return value.map(item => quotedText(item, depth + 1)).join('\n')
  if (!value || typeof value !== 'object') return ''
  const body = value as Record<string, unknown>
  if (body.elementType === 'TEXT' && typeof body.value === 'string') return body.value
  if (Array.isArray(body.cardContent)) return quotedText(body.cardContent, depth + 1)
  if (Array.isArray(body.children)) return quotedText(body.children, depth + 1)
  return contentText(value)
}
function senderIdentity(message: z.output<typeof Message>, dingTalkId: string) {
  return senderIdentities(key(message.robotCode, message.senderCorpId, dingTalkId))
}
/** The Stream mention list identifies recipients but does not locate them in the message body. */
function mentionedStaffIds(message: z.output<typeof Message>, context: SourceContext): (string | null)[] {
  if (!Array.isArray(message.atUsers)) return []
  const recipients = new Map<string, string | null>()
  for (const item of message.atUsers.slice(0, 50)) {
    const parsed = AtUser.safeParse(item)
    if (!parsed.success) continue
    const { dingtalkId, staffId } = parsed.data
    if (!dingtalkId && !staffId || dingtalkId && dingtalkId === message.chatbotUserId) continue
    const observed = !dingtalkId ? undefined : dingtalkId === message.senderId ? message.senderStaffId
      : context.state.get(senderIdentity(message, dingtalkId))
    const identity = observed === null || observed && staffId && observed !== staffId ? null : staffId ?? observed ?? null
    recipients.set(dingtalkId ? `opaque:${dingtalkId}` : `staff:${staffId}`, identity)
  }
  return [...recipients.values()]
}
export function dingTalkTrigger(raw: unknown, context: SourceContext): {
  trigger: Trigger; route: Route; body?: { messageType: string; content: unknown }; senderKey?: ReturnType<typeof senderIdentity>
} | undefined {
  // The agreed receiving scope is group mentions; content type is not an additional filter.
  if (!raw || typeof raw !== 'object') return
  const head = raw as Record<string, unknown>
  if (head.conversationType !== '2' || head.isInAtList !== true) return
  const message = Message.parse(raw)
  if (message.senderId && message.senderId === message.chatbotUserId) return
  const text = [message.text?.content, contentText(message.content)].filter(value => value?.trim()).join('\n').trim()
    || `[钉钉 ${message.msgtype} 消息，未提供可解析文本；附件内容尚未下载或解析]`
  const id = key('dingtalk', message.robotCode, message.conversationId, message.msgId)
  const quote = quotedMessage(head)
  const replyToBot = !!quote?.senderId && !!message.chatbotUserId && quote.senderId === message.chatbotUserId
  const botQuote = replyToBot ? quotedText(quote?.content) : ''
  const directReference = ticketReference(text)
  const reference = directReference ?? ticketReference(botQuote)
  const saved = reference ? context.state.get(tickets(message.conversationId, reference)) : undefined
  const matches = reference ? (saved ? [context.tickets.get(saved)].filter(ticket => !!ticket)
    : context.tickets.open().filter(ticket => ticket.id.startsWith(reference)))
    .filter(ticket => context.triggers.get(ticket!.origin.triggerId)?.channel?.address.conversationId === message.conversationId) : []
  // Unknown/ambiguous references get their own evaluation, never fan out to another group's ticket.
  const origin = matches.length === 1 ? context.triggers.get(matches[0]!.origin.triggerId) : undefined
  const threads = origin?.threads ?? [{ source: 'dingtalk', id }]
  const conversation = message.conversationId
  const mentions = mentionedStaffIds(message, context)
  return {
    ...(message.senderId && message.senderId.length <= 256 && message.senderStaffId.length <= 128
      ? { senderKey: senderIdentity(message, message.senderId) } : {}),
    trigger: { id, source: 'dingtalk', threads, actor: { source: 'dingtalk', id: message.senderStaffId }, human: true,
      addressed: 'mention', at: new Date(message.createAt ?? Date.now()).toISOString(), text,
      channel: { source: 'dingtalk', thread: `dingtalk:${conversation}`, address: { conversationId: conversation, triggerId: id } },
      meta: { conversationId: conversation, conversationType: '2', senderCorpId: message.senderCorpId, robotCode: message.robotCode,
        messageId: message.msgId, messageType: message.msgtype, chatbotUserId: message.chatbotUserId,
        ...(mentions.length ? { mentionedStaffIds: mentions } : {}),
        ...(message.senderNick?.trim() ? { senderNick: message.senderNick.trim().slice(0, 200) } : {}),
        ...(quote ? { replyToMessageId: quote.msgId, replyToMessageType: quote.msgType, replyToBot } : {}),
        ...(botQuote ? { replyToBotText: botQuote.slice(0, 8000) } : {}),
        ...(reference ? { referenceSource: directReference ? 'text' : 'quote' } : {}),
        ...(reference ? { ticketReference: reference, referenceResolved: matches.length === 1 } : {}) } },
    route: { webhook: message.sessionWebhook, expires: message.sessionWebhookExpiredTime, robotCode: message.robotCode,
      conversationId: conversation, corpId: message.senderCorpId },
    ...(message.content !== undefined || quote ? { body: { messageType: message.msgtype,
      content: quote ? { content: message.content, quote } : message.content } } : {}),
  }
}
export interface DingTalkIntake {
  conversationId?: string
  forConversation?: (conversationId: string) => DingTalkIntake | undefined
  project?: { id: string; repository: string | null }
  onSender?: (trigger: Trigger) => string | undefined
  onStored?: (trigger: Trigger) => void
  onMeeting?: (trigger: Trigger) => string
  discussion?: (trigger: Trigger) => (() => string) | undefined
}
/** Translates DingTalk Stream callbacks and group sends through the original SourceContext boundary. */
export class DingTalk {
  private readonly client: DWClient
  private readonly cards?: DingTalkCards
  private token?: { value: string; until: number }
  private streamStatus?: ReturnType<typeof setInterval>
  constructor(private readonly context: SourceContext, private readonly credentials: { clientId: string; clientSecret: string },
    private readonly log: (event: string) => void,
    private readonly http: typeof fetch = fetch, cardTemplateId?: string, robotName = 'Super agent',
    intake?: DingTalkIntake) {
    this.client = new DWClient({ ...credentials, debug: false, keepAlive: true })
    if (cardTemplateId) {
      this.cards = new DingTalkCards(context, cardTemplateId, () => this.accessToken(), http, credentials.clientId, robotName)
    }
    this.client.registerCallbackListener(TOPIC_ROBOT, async frame => {
      try {
        const parsed = dingTalkTrigger(JSON.parse(frame.data), context)
        if (parsed && (!intake?.conversationId || intake.conversationId === parsed.route.conversationId)) await context.atomic(() => {
          const { trigger, senderKey } = parsed
          if (senderKey && context.config('dingtalk') !== undefined) {
            const observed = context.state.get(senderKey)
            if (observed === undefined) context.state.set(senderKey, trigger.actor.id)
            else if (observed !== null && observed !== trigger.actor.id) context.state.set(senderKey, null)
          }
          const handlers = intake?.forConversation ? intake.forConversation(parsed.route.conversationId) : intake
          if (handlers?.project) {
            trigger.meta.projectId = handlers.project.id
            trigger.meta.projectRepository = handlers.project.repository
          }
          const textCommand = (trigger.meta.messageType === 'text' || trigger.meta.messageType === 'richText')
            && context.config('dingtalk') !== undefined
          const enrollment = textCommand && handlers?.onSender ? enrollmentIntent(trigger.text) : undefined
          const meeting = textCommand && handlers?.onMeeting && /^项目会议纪要(?:[：:]|\r?\n)/u.test(trigger.text)
          const handle = enrollment === 'self' ? handlers?.onSender : enrollment === 'help' ? () => enrollmentHelp(handlers?.project)
            : meeting ? handlers?.onMeeting : undefined
          const discussion = context.config('dingtalk') !== undefined && !handle ? handlers?.discussion?.(trigger) : undefined
          if (enrollment) trigger.meta.projectEnrollment = true
          if (meeting) trigger.meta.projectMeeting = true
          if (discussion) trigger.meta.projectDiscussion = true
          context.state.set(dingTalkRoute(parsed.route.conversationId), parsed.route)
          // Preserve native content/attachment references in the original Source KV, separate from model text.
          if (parsed.body) {
            const attachment = nativeFile(parsed.route.conversationId, String(trigger.meta.messageId), parsed.body)
            if (attachment) trigger.meta.attachments = [attachment.descriptor]
            context.state.set(bodies(parsed.trigger.id), parsed.body)
          }
          const result = context.receive(trigger)
          if (result instanceof Promise) throw new Error('DingTalk intake must commit synchronously')
          if ((handle || discussion) && result === 'filtered' && trigger.channel) {
            const text = discussion ? discussion() : handle?.(trigger)
            if (text) context.notify({ id: key('dingtalk-project-receipt', trigger.id), channel: trigger.channel, kind: 'notice', text })
          } else if (result === 'stored') {
            handlers?.onStored?.(trigger)
            this.received(trigger)
          }
          return result
        })
        // Acknowledge only after the event and pending work have committed.
        this.client.socketCallBackResponse(frame.headers.messageId, null)
      } catch { this.log('dingtalk_receive_failed') /* No ACK: DingTalk can redeliver. Never log credentials or payloads. */ }
    })
    const getEndpoint = this.client.getEndpoint.bind(this.client)
    this.client.getEndpoint = async () => {
      try { return await getEndpoint() }
      catch { this.log('dingtalk_connection_failed'); throw new Error('DingTalk Stream authentication or connection failed') }
    }
  }
  /** Use the same receipt card for native messages and externally bound event requests. */
  received(trigger: Trigger): void {
    if (this.cards) { this.cards.received(trigger); return }
    if (trigger.source === 'dingtalk' && trigger.human && trigger.addressed && trigger.channel?.source === 'dingtalk')
      this.context.notify({ id: key('dingtalk-intake-receipt', trigger.id), channel: trigger.channel, kind: 'notice',
        text: '已收到这条请求，正在判断如何处理。' })
  }
  bindWorkerDelivery(ticketId: string, deliveryId: string, triggerId: string) {
    return this.cards?.delivery(ticketId, deliveryId, triggerId)
  }
  async start(): Promise<void> {
    await this.client.connect()
    if (!this.client.connected) { this.client.disconnect(); throw new Error('DingTalk Stream did not connect') }
    this.context.report('dingtalk', { state: 'ready', detail: 'Stream connected' })
    let connected = true
    this.streamStatus = setInterval(() => {
      if (connected === this.client.connected) return
      connected = this.client.connected
      this.context.report('dingtalk', connected ? { state: 'ready', detail: 'Stream connected' }
        : { state: 'error', detail: 'Stream disconnected; waiting to reconnect' })
    }, 5000)
    this.streamStatus.unref()
    this.log('dingtalk_connected')
  }
  stop(): void { clearInterval(this.streamStatus); this.client.disconnect() }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value
    const result = await this.http('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ appKey: this.credentials.clientId, appSecret: this.credentials.clientSecret }),
    })
    const data = await result.json() as { accessToken?: string; expireIn?: number }
    if (!result.ok || !data.accessToken) throw new Error('DingTalk token request failed')
    this.token = { value: data.accessToken, until: Date.now() + Math.max(0, (data.expireIn ?? 7200) - 60) * 1000 }
    return this.token.value
  }

  async readProjectAttachment(message: ProjectMessage, attachment: MessageAttachment, lifetime: AbortSignal): Promise<Buffer> {
    const { conversationId, triggerId } = message.channel.address
    const payload = triggerId && this.context.state.get(bodies(triggerId))
    const route = conversationId && this.context.state.get(dingTalkRoute(conversationId))
    const file = payload && conversationId && message.nativeMessageId && nativeFile(conversationId, message.nativeMessageId, payload)
    if (message.channel.source !== 'dingtalk' || triggerId !== message.messageId || !route || !file || file.descriptor.id !== attachment.id) {
      throw new AttachmentReadError('无法验证这个钉钉附件的来源，请在项目群重新引用文件。')
    }
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(20_000)])
    const token = await this.accessToken()
    const response = await this.http('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ robotCode: route.robotCode, downloadCode: file.downloadCode }),
    })
    const result = await response.json() as { downloadUrl?: string; code?: string }
    if (!response.ok || !result.downloadUrl) {
      throw new AttachmentReadError(result.code === 'invalidParameter.robotCode.downloadCode'
        ? '钉钉附件下载码无效或已过期，请重新引用这份文件并 @ 机器人。'
        : '钉钉未授权下载这份附件，请重新引用文件或提供机器人可访问的副本。')
    }
    const url = new URL(result.downloadUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['dingtalk.com', 'dingtalkapps.com', 'aliyuncs.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw new AttachmentReadError('钉钉返回了不受支持的附件下载地址。')
    }
    const download = await this.http(url, { signal, redirect: 'error' })
    if (!download.ok || !download.body) throw new AttachmentReadError('附件链接暂时无法下载，请重新引用这份文件。')
    if (Number(download.headers.get('Content-Length')) > maxAttachmentBytes) {
      await download.body.cancel()
      throw new AttachmentReadError('附件超过大小上限。')
    }
    const chunks: Uint8Array[] = []
    let length = 0
    const stream = download.body.getReader()
    try {
      while (true) {
        const chunk = await stream.read()
        if (chunk.done) break
        length += chunk.value.length
        if (length > maxAttachmentBytes) throw new AttachmentReadError('附件超过大小上限。')
        chunks.push(chunk.value)
      }
      return Buffer.concat(chunks, length)
    } finally { await stream.cancel() }
  }
  async send(message: OutboundMessage): Promise<void> {
    const conversation = message.channel.address.conversationId!
    const route = this.context.state.get(dingTalkRoute(conversation))
    if (message.ticketId) this.context.state.set(tickets(conversation, message.ticketId.slice(0, 12)), message.ticketId)
    const eventLabel = message.channel.address.eventLabel
    const heading = [message.ticketId ? label(message.ticketId) : '', eventLabel ?? ''].filter(Boolean).join(' · ')
    const mention = message.channel.address.mentionUserId
    const body = heading ? `${heading}${eventLabel ? '\n' : ' '}${message.text}` : message.text
    const markdown = message.format === 'markdown'
    const title = message.title ?? '项目更新'
    if (body.length > 4000) throw new Error('DingTalk result exceeds 4000 characters; provide a brief result and a link')
    // Project lifecycle notices are sent to the group without threading them under an old request card.
    if (this.cards && (message.kind !== 'notice' || message.channel.address.triggerId || message.channel.address.cardId || message.ticketId)) {
      await this.cards.send(message)
      this.context.state.set(deliveries(conversation), { messageId: message.id, format: 'markdown', transport: 'ai-card', messageType: 'card', at: new Date().toISOString() })
      return
    }
    const url = route ? new URL(route.webhook) : undefined
    if (url && (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com')) throw new Error('Invalid DingTalk session webhook')
    // A long coding task can outlive the session webhook. Use the application group-send API after expiry.
    const active = !!route && route.expires > Date.now() + 5000
    const mentionName = message.channel.address.mentionUserName
    if (!active && mention && mentionName && this.cards) {
      await this.cards.sendMentionNotice(message.id, {
        conversationId: conversation, robotCode: route?.robotCode ?? this.credentials.clientId, userId: mention, name: mentionName,
      }, { title, text: body })
      this.context.state.set(deliveries(conversation), { messageId: message.id, format: 'markdown', transport: 'ai-card', messageType: 'card', at: new Date().toISOString() })
      return
    }
    // The application group-send API does not render mentions. Display the recipient's name as ordinary text.
    const text = active && mention ? `@${mention} ${body}` : mention && mentionName ? `请 ${mentionName} 查看\n\n${body}` : body
    if (text.length > 4000) throw new Error('DingTalk result exceeds 4000 characters; provide a brief result and a link')
    const token = await this.accessToken()
    const response = await this.http(active ? url! : 'https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      signal: AbortSignal.timeout(15000), body: JSON.stringify(active
        ? { ...(markdown ? { msgtype: 'markdown', markdown: { title, text } } : { msgtype: 'text', text: { content: text } }), ...(mention && { at: { atUserIds: [mention] } }) }
        : { robotCode: route?.robotCode ?? this.credentials.clientId, openConversationId: conversation,
          msgKey: markdown ? 'sampleMarkdown' : 'sampleText', msgParam: JSON.stringify(markdown ? { title, text } : { content: text }) }),
    })
    const data = await response.json() as { errcode?: number; code?: string; processQueryKey?: string }
    if (!response.ok || (active ? data.errcode !== 0 : !!data.code || !data.processQueryKey)) {
      throw new Error(`DingTalk message send failed (HTTP ${response.status}); check robot permissions and group membership`)
    }
    this.context.state.set(deliveries(conversation), { messageId: message.id, format: markdown ? 'markdown' : 'text',
      transport: active ? 'session-webhook' : 'application-group-api', messageType: active ? markdown ? 'markdown' : 'text' : markdown ? 'sampleMarkdown' : 'sampleText', at: new Date().toISOString() })
  }
}
/** The original SourceRegistry and Outbox own admission and delivery; this kind only translates DingTalk messages. */
export function dingTalkKind(send: (message: OutboundMessage) => Promise<void>): SourceKind {
  return {
    kind: 'dingtalk', title: { zh: '钉钉', en: 'DingTalk' },
    description: { zh: 'Stream 群内 @ 消息（所有消息类型）', en: 'Stream group mentions (all message types)' },
    schema: z.object({}).strict(), fields: [], health: ['dingtalk'],
    projectEvents: [projectMessageReceived],
    scope: ({ meta }) => {
      if (meta.projectEnrollment === true) return { listened: false, reason: 'DingTalk project membership command' }
      if (meta.projectMeeting === true) return { listened: false, reason: 'DingTalk meeting minutes for project review' }
      if (meta.projectDiscussion === true) return { listened: false, reason: 'DingTalk project meeting discussion' }
      return meta.conversationType === '2' ? { listened: true, observed: false, row: 'group' }
        : { listened: false, reason: 'Only group messages are supported' }
    },
    channel: {
      formats: ['text', 'markdown'],
      transports: ['session-webhook (text/markdown)', 'application-group-api (sampleText/sampleMarkdown)'],
      documentation: ['https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots', 'https://open.dingtalk.com/document/robots/custom-robot-access'],
      deliveryInfo: (host, channel) => channel.address.conversationId ? host.state.get(deliveries(channel.address.conversationId)) : undefined,
      send: async (_host, message) => { await send(message); return 'sent' },
      link: () => ({ url: '', label: { zh: '钉钉群', en: 'DingTalk group' } }),
    },
  }
}

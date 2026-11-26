/** dingtalk data source: configuration, normalization, context, transport and lifecycle. */
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { type SourceContext } from './host.ts'
import { type ProjectPlanning } from '../app/project-planning.ts'
import { type ProjectAgent } from '../app/project-agent.ts'
import type { Projects } from '../app/projects.ts'
import { enrollmentIntent, isMeetingMinutes, meetingClarification, meetingEvidence, meetingFeedback, submitFirstProjectMinutes, submitProjectConversation } from '../app/project-intake.ts'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { z } from 'zod'
import { type ProjectConversationSource, type SourceDelivery, type SourceKind } from './kind.ts'
import { maxProjectAttachments, projectMessageReceived, type MessageAttachment, type ProjectMessage } from './project-message.ts'
import { DingTalkCards } from './dingtalk-cards.ts'
import { AttachmentReadError, maxAttachmentBytes, readAttachmentText, supportedAttachment } from '../app/attachment-text.ts'
import type { LinkedDocumentReader } from '../app/project-attachments.ts'

// dingtalk-projects: provider implementation
function sender(trigger: Trigger) {
  const corpId = trigger.meta.senderCorpId
  const name = typeof trigger.meta.senderNick === 'string' ? trigger.meta.senderNick : `钉钉成员 ${trigger.actor.id.slice(-6)}`
  return { corpId: typeof corpId === 'string' && corpId.length <= 128 && trigger.actor.id.length <= 128 ? corpId : undefined, name }
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
        const { corpId, name } = sender(trigger)
        const member = corpId ? projects.directoryMemberForAccount('dingtalk', corpId, trigger.actor.id) : undefined
        return submitFirstProjectMinutes(planning, trigger, { dingTalkGroup: group }, name, member?.id)
      },
    }
  } }
}

export function dingTalkProjects(conversationId: string, projectId: string, projects: Projects, planning: ProjectPlanning, agent?: ProjectAgent): DingTalkIntake {
  const enrollFirst = '请先在项目群里 @ 我发送「登记项目成员」。'
  const evidence = (trigger: Trigger) => {
    const { corpId, name } = sender(trigger)
    const member = corpId ? projects.memberForAccount(projectId, 'dingtalk', corpId, trigger.actor.id) : undefined
    return meetingEvidence(trigger, name, member?.id)
  }
  const meetingMessage = (trigger: Trigger, text = trigger.text) => ({ ...evidence(trigger), projectId, text,
    channel: trigger.channel, clarificationHint: meetingClarification })
  const manage = (trigger: Trigger) => {
    const { memberId } = evidence(trigger)
    if (!memberId) return enrollFirst
    if (!trigger.channel || !agent) return '项目消息通道尚未就绪。'
    const { corpId } = sender(trigger)
    if (!corpId) return enrollFirst
    const attachments = Array.isArray(trigger.meta.attachments) ? trigger.meta.attachments as MessageAttachment[] : undefined
    const quotedLinks = trigger.meta.quotedDocumentLinks
    const mentions = Array.isArray(trigger.meta.mentionedStaffIds) ? trigger.meta.mentionedStaffIds.map(id => typeof id === 'string' ? id : null) : []
    const result = submitProjectConversation(agent, projects, projectId, memberId, corpId, {
      messageId: trigger.id, channel: trigger.channel, text: trigger.text,
      quoted: typeof trigger.meta.replyToBotText === 'string' ? trigger.meta.replyToBotText : '',
      sentAt: trigger.at, nativeMessageId: typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined,
      replyToNativeMessageId: typeof trigger.meta.replyToMessageId === 'string' ? trigger.meta.replyToMessageId : undefined,
      ...(Array.isArray(quotedLinks) && quotedLinks.length && { quotedDocumentLinks: quotedLinks }),
      ...(attachments?.length && { attachments, ...(trigger.meta.attachmentOnly === true && { attachmentOnly: true as const }) }),
    }, mentions)
    return result.status === 'disabled' ? '项目消息处理已关闭，可在事件配置中开启。' :
      { text: '已收到，正在结合项目现状处理。', kind: 'acknowledgement' as const }
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
      const explicit = meetingFeedback.test(trigger.text)
      const quote = typeof trigger.meta.replyToMessageId === 'string' && projects.detail(projectId).decisions
        .find(item => item.meetingSource?.messageId === trigger.meta.replyToMessageId)
      if (!meeting || !(explicit || quote || status === 'planning')) return
      return () => {
        const text = trigger.text.replace(meetingFeedback, '').trim()
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
type NativeBody = { messageType: string; content: unknown }
type NativeAttachment = { descriptor: MessageAttachment; downloadCode?: string }
const bodies = family<NativeBody, [string]>('dingtalk-body:')
const DownloadCode = z.string().min(1).max(4000)
const NativeFile = z.object({ fileName: z.string().trim().min(1).max(300), downloadCode: DownloadCode, fileId: z.string().optional() })
const NativeImage = z.object({ type: z.string().optional(), downloadCode: DownloadCode.optional(), pictureDownloadCode: DownloadCode.optional() })
const RichText = z.object({ richText: z.array(z.unknown()) })

function attachmentParts(conversation: string, messageId: string, messageType: string, content: unknown): NativeAttachment[] {
  const nativeMessageId = messageId.trim()
  if (!nativeMessageId || nativeMessageId.length > 300) return []
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { return [] }
  }
  if (messageType === 'file') {
    const file = NativeFile.safeParse(content).data
    return file ? [{ descriptor: { id: key('dingtalk-file', conversation, nativeMessageId, file.fileId ?? file.fileName),
      name: file.fileName, nativeMessageId }, downloadCode: file.downloadCode }] : []
  }
  const parts = messageType === 'picture' ? [content] : messageType === 'richText' ? RichText.safeParse(content).data?.richText ?? [] : []
  const images: NativeAttachment[] = []
  for (const [slot, part] of parts.entries()) {
    const image = NativeImage.safeParse(part).data
    if (messageType === 'richText' && image?.type !== 'picture' && !image?.pictureDownloadCode) continue
    const downloadCode = image?.pictureDownloadCode ?? image?.downloadCode
    images.push({ descriptor: { id: key('dingtalk-image', conversation, nativeMessageId, String(slot)), kind: 'image',
      name: `图片 ${images.length + 1}`, nativeMessageId }, downloadCode })
    if (images.length >= maxProjectAttachments) break
  }
  return images
}

function unpackBody(payload: NativeBody) {
  const content = payload.content
  return content && typeof content === 'object' && 'quote' in content
    ? { quote: QuotedMessage.safeParse(content.quote).data, content: 'content' in content ? content.content : undefined }
    : { content }
}

function nativeAttachments(route: Route, messageId: string, payload: NativeBody, stored: (id: string) => NativeBody | undefined): NativeAttachment[] {
  const { conversationId, robotCode } = route
  const { content, quote } = unpackBody(payload)
  const all = attachmentParts(conversationId, messageId, payload.messageType, content)
  if (quote?.msgId && quote.msgType && all.length < maxProjectAttachments) {
    const id = quote.msgId.trim()
    const quoted = attachmentParts(conversationId, id, quote.msgType, quote.content)
    const original = !quoted.some(item => item.downloadCode) && id && id.length <= 300
      ? stored(key('dingtalk', robotCode, conversationId, id)) : undefined
    all.push(...(original ? attachmentParts(conversationId, id, original.messageType, unpackBody(original).content) : quoted))
  }
  return [...new Map(all.map(item => [item.descriptor.id, item])).values()].slice(0, maxProjectAttachments)
}
const senderIdentities = family<string | null, [string]>('dingtalk-sender-identity:')
const optionalIdentity = z.string().min(1).max(256).optional()
const AtUser = z.object({ dingtalkId: optionalIdentity, staffId: z.string().min(1).max(128).optional() })
const deliveries = family<{ messageId: string; format: string; transport: string; messageType: string; at: string; nativeMention?: boolean }, [string]>('dingtalk-last-delivery:')
const Message = z.object({ msgId: z.string().min(1), conversationId: z.string().min(1),
  conversationType: z.string(), isInAtList: z.boolean().optional(), senderStaffId: z.string().min(1),
  senderCorpId: z.string().min(1), senderNick: z.string().optional(), chatbotUserId: z.string().optional(), senderId: z.string().optional(),
  robotCode: z.string().min(1), msgtype: z.string(), text: z.object({ content: z.string().optional() }).nullish(),
  content: z.unknown().optional(), atUsers: z.unknown().optional(),
  createAt: z.number().optional(), sessionWebhook: z.string().url(), sessionWebhookExpiredTime: z.number() })
export interface Route { webhook: string; expires: number; robotCode: string; conversationId: string; corpId?: string }
export const ticketReference = (text: string): string | undefined => /(?:^|\s)#([a-f0-9]{12,32})(?=\s|$|[，。,:：])/i.exec(text)?.[1]?.toLowerCase()
export const label = (id: string): string => `#${id.slice(0, 12)}`
const picturePlaceholder = '[图片附件]'
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
  if (body.type === 'picture' || body.pictureDownloadCode) return `\n${picturePlaceholder}\n`
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
/** Recognizes canonical document links carried by a quoted DingTalk card, independently of its sender. */
function documentLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return
  const url = URL.parse(value)
  if (url?.origin !== 'https://alidocs.dingtalk.com' || url.username || url.password ||
    !/^\/i\/nodes\/[a-zA-Z0-9_-]{1,512}\/?$/.test(url.pathname)) return
  return url.origin + url.pathname.replace(/\/$/, '')
}

function quotedDocumentLinks(quote: z.output<typeof QuotedMessage> | undefined): string[] {
  if (quote?.msgType !== 'interactiveCard') return []
  let content = quote.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { return [] }
  }
  if (!content || typeof content !== 'object') return []
  const card = content as Record<string, unknown>
  const candidates = Array.isArray(card.cardContent) ? card.cardContent.slice(0, 50)
    .flatMap(node => node?.elementType === 'LINK' ? [node.value] : []) : []
  const links = [card.biz_custom_action_url, ...candidates].map(documentLink).filter(link => link !== undefined)
  return [...new Set(links)].slice(0, 3)
}

const DocumentNode = z.object({ name: z.string().min(1), nodeId: z.string().optional(),
  type: z.string(), category: z.string(), extension: z.string().optional() })
const DownloadInfo = z.object({ headerSignatureInfo: z.object({
  resourceUrls: z.array(z.string()).min(1), headers: z.record(z.string(), z.string()).optional(),
}) })
function dingTalkNetworkFailure(code: unknown): AttachmentReadError | undefined {
  if (code === 'Forbidden.AccessDenied.IpNotInWhiteList')
    return new AttachmentReadError('钉钉开放平台拒绝本机的出口 IP。请让应用管理员在「开发管理 → 服务器出口 IP」中核对并允许本机出口 IP，保存后再试。', 'deployment')
}
function documentFailure(stage: string, status: number, code?: unknown): AttachmentReadError {
  const network = dingTalkNetworkFailure(code)
  if (network) return network
  if (stage === '核验发送者身份' && (code === 88 || code === '88'))
    return new AttachmentReadError('钉钉应用尚未开通成员信息读权限，无法核验当前发送者。请由应用管理员在钉钉开发者后台开通。', 'deployment')
  const error = typeof code === 'string' ? code : ''
  if (status === 401 || status === 403 || /permission|forbidden|accessDenied|noPrivilege|noAuthority|Unauthorized/i.test(error))
    return new AttachmentReadError(`钉钉拒绝${stage}，请检查应用权限和你对该资料的访问权限。`)
  if (status === 404 || /notExist|notFound/i.test(error)) return new AttachmentReadError(`钉钉找不到${stage === '核验发送者身份' ? '发送者的企业账号' : '这份资料'}。`)
  if (status === 429) return new AttachmentReadError('钉钉接口暂时限流，请稍后重试。')
  return new AttachmentReadError(`${stage}失败（钉钉 HTTP ${status}）。`)
}

function blockText(value: unknown, depth = 0): string {
  if (!value || typeof value !== 'object' || depth >= 12) return ''
  if (Array.isArray(value)) return value.map(item => blockText(item, depth + 1)).filter(Boolean).join('')
  const block = value as Record<string, unknown>
  if (typeof block.text === 'string') return block.text
  if (block.text && typeof block.text === 'object') {
    const text = (block.text as Record<string, unknown>).text
    if (typeof text === 'string') return text
    const content = (block.text as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }
  // Inline text, paragraph containers, and nested blocks such as lists and table cells.
  return Object.entries(block).filter(([key]) =>
    /^(children|paragraph|heading\d*|list|listItem|bulletList|orderedList|table|tableRow|tableCell|rows|cells|quote|codeBlock)$/i.test(key))
    .map(([, child]) => blockText(child, depth + 1)).filter(Boolean).join('\n')
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
    || (message.msgtype === 'picture' ? picturePlaceholder : `[钉钉 ${message.msgtype} 消息，未提供可解析文本；附件内容尚未下载或解析]`)
  const id = key('dingtalk', message.robotCode, message.conversationId, message.msgId)
  const quote = quotedMessage(head)
  const documentLinks = quotedDocumentLinks(quote)
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
        ...(documentLinks.length && { quotedDocumentLinks: documentLinks }),
        ...(botQuote ? { replyToBotText: botQuote.slice(0, 8000) } : {}),
        ...(reference ? { referenceSource: directReference ? 'text' : 'quote' } : {}),
        ...(reference ? { ticketReference: reference, referenceResolved: matches.length === 1 } : {}) } },
    route: { webhook: message.sessionWebhook, expires: message.sessionWebhookExpiredTime, robotCode: message.robotCode,
      conversationId: conversation, corpId: message.senderCorpId },
    ...(message.content !== undefined || quote || message.msgtype === 'picture' ? { body: { messageType: message.msgtype,
      content: quote ? { content: message.content, quote } : message.content } } : {}),
  }
}
type ProjectIntakeReply = string | { kind: 'acknowledgement'; text: string }
export interface DingTalkIntake {
  conversationId?: string
  forConversation?: (conversationId: string) => DingTalkIntake | undefined
  project?: { id: string; repository: string | null }
  onSender?: (trigger: Trigger) => string | undefined
  onStored?: (trigger: Trigger) => void
  onMeeting?: (trigger: Trigger) => ProjectIntakeReply
  discussion?: (trigger: Trigger) => (() => ProjectIntakeReply) | undefined
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
          const meeting = textCommand && handlers?.onMeeting && isMeetingMinutes(trigger.text)
          const handle = enrollment === 'self' ? handlers?.onSender : enrollment === 'help' ? () => enrollmentHelp(handlers?.project)
            : meeting ? handlers?.onMeeting : undefined
          const discussion = context.config('dingtalk') !== undefined && !handle ? handlers?.discussion?.(trigger) : undefined
          if (enrollment) trigger.meta.projectEnrollment = true
          if (meeting) trigger.meta.projectMeeting = true
          if (discussion) trigger.meta.projectDiscussion = true
          context.state.set(dingTalkRoute(parsed.route.conversationId), parsed.route)
          // Preserve native content/attachment references in the original Source KV, separate from model text.
          if (parsed.body) {
            const attachments = nativeAttachments(parsed.route, String(trigger.meta.messageId), parsed.body, id => context.state.get(bodies(id)))
            if (attachments.length) {
              trigger.meta.attachments = attachments.map(item => item.descriptor)
              if (trigger.text.split(/\s*\n\s*/).filter(Boolean).every(line => line === picturePlaceholder))
                trigger.meta.attachmentOnly = true
            }
            context.state.set(bodies(parsed.trigger.id), parsed.body)
          }
          const result = context.receive(trigger)
          if (result instanceof Promise) throw new Error('DingTalk intake must commit synchronously')
          if ((handle || discussion) && result === 'filtered' && trigger.channel) {
            const reply = discussion ? discussion() : handle?.(trigger)
            if (reply) context.notify({ id: key('dingtalk-project-receipt', trigger.id), channel: trigger.channel,
              ...(typeof reply === 'string' ? { kind: 'notice' as const, text: reply } : reply) })
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

  linkedDocumentReader(corpId: string | undefined): LinkedDocumentReader {
    return { recognize: documentLink, read: (message, link, signal) => this.readLinkedDocument(message, link, corpId, signal) }
  }

  private async readLinkedDocument(message: ProjectMessage, link: string, corpId: string | undefined, lifetime: AbortSignal) {
    const canonical = documentLink(link)
    const trigger = this.context.triggers.get(message.messageId)
    if (!corpId) throw new AttachmentReadError('这套部署尚未配置钉钉在线文档读取的企业 ID。')
    if (!canonical || !message.actorId || !trigger?.human || trigger.source !== 'dingtalk' || trigger.actor.source !== 'dingtalk' ||
      message.channel.address.triggerId !== trigger.id || trigger.channel?.thread !== message.channel.thread ||
      trigger.meta.conversationId !== message.channel.address.conversationId || trigger.meta.senderCorpId !== corpId)
      throw new AttachmentReadError('无法验证当前发送者属于已配置的钉钉企业。')
    const nodeId = canonical.split('/').at(-1)!
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(20_000)])
    const token = await this.accessToken().catch(() => { throw new AttachmentReadError('无法取得钉钉应用访问凭证，请检查部署配置。') })
    signal.throwIfAborted()
    const directory = new URL('https://oapi.dingtalk.com/topapi/v2/user/get')
    directory.searchParams.set('access_token', token)
    const identity = await this.documentJson(directory, '核验发送者身份', signal, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: trigger.actor.id }),
    })
    const operatorId = z.string().min(1).max(256).safeParse((identity.result as { unionid?: unknown } | undefined)?.unionid).data
    if (!operatorId) throw new AttachmentReadError('钉钉没有返回发送者的企业成员标识，请检查应用的成员信息读权限。')

    const query = (path: string, stage: string, parameters: Record<string, string>, body?: object) => {
      const url = new URL(`https://api.dingtalk.com${path}`)
      url.search = new URLSearchParams(parameters).toString()
      return this.documentJson(url, stage, signal, {
        headers: { 'x-acs-dingtalk-access-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      })
    }
    const metadata = await query(`/v2.0/wiki/nodes/${nodeId}`, '读取资料信息', { operatorId })
    const node = DocumentNode.safeParse(metadata.node).data
    if (!node || node.nodeId && node.nodeId !== nodeId) throw new AttachmentReadError('钉钉没有返回与资料链接匹配的文件信息。')
    const name = node.name.trim().slice(0, 180) || '钉钉在线文档'
    const format = node.extension?.toLowerCase()
    if (node.type.toUpperCase() !== 'FILE') throw new AttachmentReadError('该链接指向钉钉目录，请提供某一份文件。')
    if (node.category.toUpperCase() === 'ALIDOC' && format === 'adoc') {
      const limit = 100
      const contents = await query(`/v1.0/doc/suites/documents/${nodeId}/blocks`, '读取文档正文',
        { operatorId, startIndex: '0', endIndex: String(limit) })
      const blocks = z.object({ success: z.literal(true), result: z.object({ data: z.array(z.unknown()) }) }).safeParse(contents).data?.result.data
      if (!blocks) throw new AttachmentReadError('钉钉没有返回可识别的文档正文。')
      const textBlocks = blocks.slice(0, limit).map(block => blockText(block).trim())
      const excerpt = textBlocks.filter(Boolean).join('\n')
      if (!excerpt) throw new AttachmentReadError('钉钉文档未返回可提取的文字。')
      const max = 18_000
      return { name, text: excerpt.slice(0, max), partial: blocks.length >= limit || excerpt.length > max || textBlocks.some(text => !text) }
    }
    if (!format || node.category.toUpperCase() === 'ALIDOC' || !supportedAttachment(`file.${format}`))
      throw new AttachmentReadError('此钉钉在线资料类型暂不支持正文读取，请导出为 HTML、PPTX、PDF 或文本文件。')
    const file = await query(`/v2.0/doc/dentries/${nodeId}/queryDentryId`, '定位上传文件', { operatorId })
    const ids = z.object({ spaceId: z.string().regex(/^[\w-]+$/), dentryId: z.string().regex(/^[\w-]+$/) }).safeParse(file).data
    if (!ids) throw new AttachmentReadError('钉钉没有返回上传文件的下载标识。')
    const info = await query(`/v1.0/storage/spaces/${ids.spaceId}/dentries/${ids.dentryId}/downloadInfos/query`, '获取文件下载权限',
      { unionId: operatorId }, { option: { preferIntranet: false } })
    const signature = DownloadInfo.safeParse(info).data?.headerSignatureInfo
    if (!signature) throw new AttachmentReadError('钉钉没有返回可用的文件下载方式。')
    const bytes = await this.downloadFile(signature.resourceUrls[0]!, signal, signature.headers ?? {})
    return { name, ...await readAttachmentText(`file.${format}`, bytes, signal) }
  }

  private async documentJson(url: URL, stage: string, signal: AbortSignal, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response
    try { response = await this.http(url, { ...init, signal, redirect: 'error' }) }
    catch { throw new AttachmentReadError(signal.aborted ? `${stage}超时。` : `${stage}时无法连接钉钉接口。`) }
    const bytes = await this.readDownloadBody(response, 2 * 1024 * 1024)
    let payload: Record<string, unknown> | undefined
    try { payload = z.record(z.string(), z.unknown()).safeParse(JSON.parse(bytes.toString('utf8'))).data } catch {}
    if (!response.ok || payload?.code || payload?.errcode && Number(payload.errcode) !== 0 || payload?.success === false)
      throw documentFailure(stage, response.status, payload?.code ?? payload?.errcode)
    if (!payload) throw new AttachmentReadError(`${stage}时钉钉返回了无法识别的响应。`)
    return payload
  }

  async readProjectAttachment(message: ProjectMessage, attachment: MessageAttachment, lifetime: AbortSignal): Promise<Buffer> {
    const { conversationId, triggerId } = message.channel.address
    const payload = triggerId && this.context.state.get(bodies(triggerId))
    const route = conversationId && this.context.state.get(dingTalkRoute(conversationId))
    const file = payload && route && message.nativeMessageId && nativeAttachments(route, message.nativeMessageId, payload, id => this.context.state.get(bodies(id)))
      .find(item => item.descriptor.id === attachment.id && item.descriptor.nativeMessageId === attachment.nativeMessageId)
    if (message.channel.source !== 'dingtalk' || triggerId !== message.messageId || !route || !file) {
      throw new AttachmentReadError('无法验证这个钉钉附件的来源，请在项目群重新引用文件。')
    }
    if (!file.downloadCode) throw new AttachmentReadError('这条消息没有可用的图片下载码，请把图片和 @ 机器人放在同一条消息里重发。')
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(20_000)])
    const token = await this.accessToken()
    const response = await this.http('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ robotCode: route.robotCode, downloadCode: file.downloadCode }),
    })
    const result = await response.json() as { downloadUrl?: string; code?: string }
    if (!response.ok || !result.downloadUrl) {
      const network = dingTalkNetworkFailure(result.code)
      if (network) throw network
      throw new AttachmentReadError(result.code === 'invalidParameter.robotCode.downloadCode'
        ? '钉钉附件下载码无效或已过期，请重新引用这份文件并 @ 机器人。'
        : '钉钉未授权下载这份附件，请重新引用文件或提供机器人可访问的副本。')
    }
    return this.downloadFile(result.downloadUrl, signal)
  }

  private async downloadFile(address: string, signal: AbortSignal, headers?: Record<string, string>): Promise<Buffer> {
    const url = URL.parse(address)
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port ||
      !['dingtalk.com', 'dingtalkapps.com', 'aliyuncs.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw new AttachmentReadError('钉钉返回了不受支持的附件下载地址。')
    }
    // DingTalk may issue an HTTP URL for an OSS object that also serves the signed URL over HTTPS.
    url.protocol = 'https:'
    const download = await this.http(url, { signal, redirect: 'error', ...(headers ? { headers } : {}) })
    if (!download.ok || !download.body) {
      await download.body?.cancel()
      if (headers) throw documentFailure('下载资料', download.status)
      throw new AttachmentReadError('附件链接暂时无法下载，请重新引用这份文件。')
    }
    return this.readDownloadBody(download, maxAttachmentBytes)
  }

  private async readDownloadBody(response: Response, limit: number): Promise<Buffer> {
    if (!response.body) return Buffer.alloc(0)
    if (Number(response.headers.get('Content-Length')) > limit) {
      await response.body.cancel()
      throw new AttachmentReadError('附件超过大小上限。')
    }
    const chunks: Uint8Array[] = []
    let length = 0
    const stream = response.body.getReader()
    try {
      while (true) {
        const chunk = await stream.read()
        if (chunk.done) break
        length += chunk.value.length
        if (length > limit) throw new AttachmentReadError('附件超过大小上限。')
        chunks.push(chunk.value)
      }
      return Buffer.concat(chunks, length)
    } finally { await stream.cancel() }
  }
  async send(message: OutboundMessage): Promise<SourceDelivery | undefined> {
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
    if (!mention && this.cards && (message.kind !== 'notice' || message.channel.address.triggerId || message.channel.address.cardId || message.ticketId)) {
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
      this.context.state.set(deliveries(conversation), { messageId: message.id, format: 'markdown', transport: 'ai-card', messageType: 'card', at: new Date().toISOString(), nativeMention: true })
      return { nativeMention: true }
    }
    // The application group-send API does not render mentions. Display the recipient's name as ordinary text.
    const recipientText = active && mention ? `@${mention} ${body}` : mention && mentionName ? `请 ${mentionName} 查看\n\n${body}` : body
    const text = !active && mention && (message.channel.address.projectRecipientId || message.channel.address.explicitMentionMemberId)
      ? `${recipientText}\n\n本条为文字提醒，当前会话的原生 @ 不可用。` : recipientText
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
    this.context.state.set(deliveries(conversation), { messageId: message.id, format: markdown ? 'markdown' : 'text', ...(mention && { nativeMention: active }),
      transport: active ? 'session-webhook' : 'application-group-api', messageType: active ? markdown ? 'markdown' : 'text' : markdown ? 'sampleMarkdown' : 'sampleText', at: new Date().toISOString() })
    return mention ? { nativeMention: active } : undefined
  }
}
/** The original SourceRegistry and Outbox own admission and delivery; this kind only translates DingTalk messages. */
export function dingTalkKind(send: (message: OutboundMessage) => Promise<SourceDelivery | void>,
  readers: Pick<ProjectConversationSource, 'attachment' | 'document'> = {}): SourceKind {
  return {
    kind: 'dingtalk', title: { zh: '钉钉', en: 'DingTalk' },
    description: { zh: 'Stream 群内 @ 消息（所有消息类型）', en: 'Stream group mentions (all message types)' },
    schema: z.object({}).strict(), fields: [], health: ['dingtalk'],
    projectEvents: [projectMessageReceived],
    projectConversation: {
      ...readers,
      binding: project => project.dingTalkGroup,
      room: channel => channel.address.conversationId,
      channel(host, project, recipient) {
        const conversationId = project.dingTalkGroup
        if (!conversationId) return
        const address: Record<string, string> = { conversationId }
        if (recipient) {
          const route = host.state.get(dingTalkRoute(conversationId))
          const meeting = route?.corpId ? undefined : project.decisions.findLast(decision => decision.meetingSource?.source === 'dingtalk')?.meetingSource
          const origin = meeting && host.triggers.get(meeting.triggerId)
          const corpId = route?.corpId ?? (origin?.meta.conversationId === conversationId ? origin.meta.senderCorpId : undefined)
          const accounts = recipient.accounts.filter(item => item.provider === 'dingtalk' && item.scope === corpId)
          if (accounts.length !== 1) return
          address.mentionUserId = accounts[0]!.accountId
          address.mentionUserName = recipient.name
        }
        return { source: 'dingtalk', thread: `dingtalk:${conversationId}`, address }
      },
    },
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
      send: async (_host, message) => (await send(message)) ?? 'sent',
      link: () => ({ url: '', label: { zh: '钉钉群', en: 'DingTalk group' } }),
    },
  }
}

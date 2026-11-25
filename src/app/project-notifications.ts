import type { ChannelRef, OutboundMessage, MessagePresentation } from '../core/index.ts'
import { KV } from '../kv.ts'
import { dingTalkRoute } from '../sources/dingtalk.ts'
import { ProjectError, type Member, type ProjectDetail } from './projects.ts'
import type { Store } from './store.ts'

export function announce(host: { store: Store; notify(message: OutboundMessage): void }, project: ProjectDetail,
  id: string, content: string | MessagePresentation, recipient?: Member) {
  if (!project.dingTalkGroup || host.store.replyStatus(id)) return
  host.notify({ id, kind: 'notice', text: typeof content === 'string' ? content : content.summary,
    ...(typeof content === 'string' ? {} : { presentation: content }), channel: projectChannel(host.store, project, recipient) })
}

/** Resolve a project's current delivery channel and verified, corporation-scoped member mention. */
export function projectChannel(store: Store, project: Pick<ProjectDetail, 'id' | 'dingTalkGroup' | 'decisions'>, recipient?: Member): ChannelRef {
  if (!project.dingTalkGroup) return { source: 'request', thread: project.id, address: {} }
  const conversationId = project.dingTalkGroup
  const address: Record<string, string> = { conversationId }
  if (recipient) {
    const route = store.get(dingTalkRoute(conversationId))
    const meeting = route?.corpId ? undefined : project.decisions.findLast(decision => decision.meetingSource?.source === 'dingtalk')?.meetingSource
    const origin = meeting && store.triggers.get(meeting.triggerId)
    const corpId = route?.corpId ?? (origin?.meta.conversationId === conversationId ? origin.meta.senderCorpId : undefined)
    const account = recipient.accounts.find(item => item.provider === 'dingtalk' && item.scope === corpId)
    if (account) {
      address.mentionUserId = account.accountId
      address.mentionUserName = recipient.name
    }
  }
  return { source: 'dingtalk', thread: `dingtalk:${conversationId}`, address }
}

export function explicitProjectMention(store: Store, projectId: string, channel: ChannelRef, memberId: string): ChannelRef {
  const project = store.get(KV.projects.project(projectId))
  if (channel.source !== 'dingtalk' || !project?.dingTalkGroup || project.status === 'archived'
    || channel.address.conversationId !== project.dingTalkGroup) {
    throw new ProjectError(409, '只能在当前项目绑定的钉钉群里 @ 成员。')
  }
  const member = project.memberIds.includes(memberId) && store.get(KV.projects.member(memberId))
  if (!member) throw new ProjectError(404, '请提供当前项目中可识别的成员。')
  const target = projectChannel(store, project, member)
  if (!target.address.mentionUserId) throw new ProjectError(409, `「${member.name}」尚未绑定本企业的钉钉账号，无法原生 @。`)
  target.address.explicitMentionMemberId = memberId
  return target
}

/** Recheck the project and recipient before sending a queued reply, including retries. */
export function obsoleteExplicitProjectMention(store: Store, message: OutboundMessage): boolean {
  const memberId = message.channel.address.explicitMentionMemberId
  if (!memberId || !message.origin?.projectId) return false
  try {
    const current = explicitProjectMention(store, message.origin.projectId, message.channel, memberId)
    return current.address.mentionUserId !== message.channel.address.mentionUserId
  } catch (error) {
    if (!(error instanceof ProjectError)) throw error
    return true
  }
}

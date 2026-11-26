import type { ChannelRef, OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { ProjectConversationSource, SourceKind } from '../sources/kind.ts'
import type { SourceHost } from '../sources/host.ts'
import type { ProjectMessage } from '../sources/project-message.ts'
import type { AttachmentReader } from './project-attachments.ts'
import { ProjectError, type Member, type Project } from './projects.ts'
import type { Store } from './store.ts'

export const projectWebChannel = (projectId: string): ChannelRef => ({ source: 'request', thread: projectId, address: {} })

/** Resolves registered project conversations and revalidates durable notification targets. */
export class ProjectChannels {
  constructor(private readonly store: Store, private readonly host: SourceHost) {}

  private adapter(source: string): (SourceKind & { projectConversation: ProjectConversationSource }) | undefined {
    const kind = this.host.sources.kind(source)
    if (kind?.projectConversation) return kind as SourceKind & { projectConversation: ProjectConversationSource }
  }

  supports(source: string): boolean { return !!this.adapter(source) }

  attachment(source: string) {
    const kind = this.adapter(source)
    const read = kind?.projectConversation.attachment
    if (kind && read && this.host.sources.instance(source)?.enabled)
      return (...args: Parameters<AttachmentReader>) => read(this.host.context(kind), ...args)
  }

  quotedAttachments(message: ProjectMessage, signal: AbortSignal) {
    const kind = this.adapter(message.channel.source)
    if (kind && this.host.sources.instance(kind.kind)?.enabled)
      return kind.projectConversation.quotedAttachments?.(this.host.context(kind), message, signal)
  }

  documents() {
    return this.host.sources.instances().filter(item => item.enabled).flatMap(item => {
      const kind = this.adapter(item.kind)
      const reader = kind?.projectConversation.document?.(this.host.context(kind))
      return reader ? [reader] : []
    })
  }

  matches(project: Project, channel: ChannelRef): boolean {
    const kind = this.adapter(channel.source)
    const room = kind?.projectConversation.room(channel)
    return !!room && room === kind?.projectConversation.binding(project)
  }

  boundProject(channel: ChannelRef): Project | undefined {
    return this.store.keys(KV.projects.project).map(key => this.store.get(key)!).find(project =>
      project.status !== 'archived' && this.matches(project, channel))
  }

  authorize(project: Project, channel: ChannelRef, member: Member): boolean {
    const kind = this.adapter(channel.source)
    return !!kind && this.matches(project, channel) && this.host.sources.channelAllowed(channel)
      && (kind.projectConversation.authorize?.(this.host.context(kind), channel, member) ?? true)
  }

  target(project: Project, recipient?: Member, preferred?: string, allowOffline = false): ChannelRef | undefined {
    if (project.status === 'archived') return
    const sources = preferred && preferred !== 'request' ? [preferred] : this.host.sources.instances().map(item => item.id)
    for (const source of sources) {
      const kind = this.adapter(source)
      if (!kind) continue
      const channel = kind.projectConversation.channel(this.host.context(kind), project, recipient)
      if (!channel || !this.matches(project, channel) || (!allowOffline && !this.host.sources.channelAllowed(channel)) ||
        recipient && !channel.address.mentionUserId) continue
      return recipient ? { ...channel, address: { ...channel.address, projectRecipientId: recipient.id } } : channel
    }
  }

  mention(projectId: string, channel: ChannelRef, memberId: string): ChannelRef {
    const project = this.store.get(KV.projects.project(projectId))
    if (!project || project.status === 'archived' || !this.matches(project, channel))
      throw new ProjectError(409, '只能在当前项目绑定的群里 @ 成员。')
    const member = project.memberIds.includes(memberId) && this.store.get(KV.projects.member(memberId))
    if (!member) throw new ProjectError(404, '请提供当前项目中可识别的成员。')
    const target = this.target(project, member, channel.source)
    if (!target) throw new ProjectError(409, `「${member.name}」尚未绑定当前平台的可用账号，无法原生 @。`)
    return target
  }

  forNotice(project: Project, recipient?: Member, preferred?: string): ChannelRef | undefined {
    const target = (recipient && this.target(project, recipient, preferred)) || this.target(project, undefined, preferred) ||
      (recipient && this.target(project, recipient, preferred, true)) || this.target(project, undefined, preferred, true)
    return target && { ...target, address: { ...target.address, projectNotice: 'true' } }
  }

  obsolete(message: OutboundMessage): boolean {
    const address = message.channel.address
    const memberId = address.projectRecipientId ?? address.explicitMentionMemberId
    if (!memberId && !address.projectNotice || !message.origin?.projectId) return false
    const project = this.store.get(KV.projects.project(message.origin.projectId))
    if (!project || project.status === 'archived' || !this.matches(project, message.channel)) return true
    if (!memberId) return false
    const member = project.memberIds.includes(memberId) && this.store.get(KV.projects.member(memberId))
    const current = member && this.target(project, member, message.channel.source, true)
    return !current || current.address.mentionUserId !== address.mentionUserId
  }
}

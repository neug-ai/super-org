import type { OutboundMessage, MessagePresentation } from '../core/index.ts'
import type { Member, ProjectDetail } from './projects.ts'
import type { ProjectChannels } from './project-channels.ts'
import type { Store } from './store.ts'

export function announce(host: { store: Store; channels: ProjectChannels; notify(message: OutboundMessage): void }, project: ProjectDetail,
  id: string, content: string | MessagePresentation, recipient?: Member, preferred?: string) {
  if (host.store.replyStatus(id)) return
  const channel = host.channels.forNotice(project, recipient, preferred)
  if (!channel) return
  host.notify({ id, kind: 'notice', text: typeof content === 'string' ? content : content.summary,
    ...(typeof content === 'string' ? {} : { presentation: content }), channel })
}

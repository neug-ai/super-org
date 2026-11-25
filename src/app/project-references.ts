import { z } from 'zod'
import { KV } from '../kv.ts'
import { maxProjectAttachments, type ProjectMessage } from '../sources/project-message.ts'
import type { ProjectAgentRun } from './project-agent.ts'
import type { AttachmentResult, ExecutionAttachment } from './project-attachments.ts'
import { findConversationTurn } from './project-conversation-history.ts'
import type { Store } from './store.ts'

const limit = 3
export const MaterialLinks = z.array(z.url({ protocol: /^https$/ }).max(600)).max(limit)
export interface ExecutionMaterials {
  attachments?: readonly ExecutionAttachment[]
  links?: readonly string[]
}
export interface ProjectReferences {
  links: string[]
  attachments: AttachmentResult[]
  message?: { id: string; text: string }
  quote: 'none' | 'inline' | 'resolved' | 'unavailable'
}

export const materialReference = (runId: string): string => `〔资料 ${runId}〕`

function sharedLinks(text: string): string[] {
  const links = new Set<string>()
  for (const match of text.matchAll(/https:\/\/[^\s<>"\u3000-\u303f\uff00-\uffef)\]]+/giu)) {
    const url = URL.parse(match[0].replace(/[.,;!?]+$/, ''))
    if (!url || url.href.length > 600 || url.username || url.password ||
      [...url.searchParams.keys()].some(name => /signature|token|credential|secret|password/i.test(name))) continue
    links.add(url.href)
    if (links.size === limit) break
  }
  return [...links]
}

/** One bounded exact lookup; never carries material or action authority across projects or chat threads. */
export function resolveProjectReferences(store: Store, message: ProjectMessage, mayReadHistory: boolean): ProjectReferences {
  const { projectId, channel, replyToNativeMessageId, quoted, quotedDocumentLinks = [], text } = message
  const scopedRun = (id: string) => {
    const run = store.get(KV.projects.agentRun(id))
    if (run?.status === 'completed' && !run.event && run.message.projectId === projectId &&
      run.message.channel.source === channel.source && run.message.channel.thread === channel.thread) return run
  }
  let source: ProjectAgentRun | undefined
  if (mayReadHistory) {
    const markers = new Set(Array.from(quoted.matchAll(/〔资料 ([a-f0-9]{32})〕/g), match => match[1]!))
    if (markers.size === 1) source = scopedRun([...markers][0]!)
    if (!source && replyToNativeMessageId) {
      const turn = findConversationTurn(store, message, replyToNativeMessageId)
      if (turn) source = scopedRun(turn.id)
    }
  }
  const sourceLinks = source?.references?.links ?? (source ?
    [...(source.message.quotedDocumentLinks ?? []), ...sharedLinks(source.message.text)] : [])
  const links = [...new Set([...quotedDocumentLinks, ...sharedLinks(text), ...sourceLinks])].slice(0, limit)
  const inline = !!(quotedDocumentLinks.length || quoted.trim() || message.attachments?.length)
  return { links, attachments: source ? referencedAttachments(source) : [],
    ...(source && { message: { id: source.id, text: source.message.text.slice(0, 1500) } }),
    quote: source ? 'resolved' : inline ? 'inline' : replyToNativeMessageId ? 'unavailable' : 'none' }
}

export function referencedAttachments(run: ProjectAgentRun): AttachmentResult[] {
  const results = new Map<string, AttachmentResult>()
  const direct = (run.attachmentResults ?? []).map((item, index) => ({
    ...item, attachmentId: item.attachmentId ?? run.message.attachments?.[index]?.id,
  }))
  for (const item of [...direct, ...(run.references?.attachments ?? [])]) {
    if ('error' in item && !item.original) continue
    const id = item.original?.file ?? JSON.stringify(item)
    if (!results.has(id)) results.set(id, item)
    if (results.size === maxProjectAttachments) break
  }
  return [...results.values()]
}

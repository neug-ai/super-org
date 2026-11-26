import { z } from 'zod'
import type { ProjectEventDefinition } from './project-events.ts'

const id = z.string().min(1).max(300)
export const maxProjectAttachments = 3
export const MessageAttachment = z.strictObject({
  id, name: z.string().min(1).max(300), nativeMessageId: id, kind: z.literal('image').optional(),
})
export type MessageAttachment = z.output<typeof MessageAttachment>
export const ProjectQuotePreview = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  summary: z.string().trim().min(1).max(1500).optional(),
}).refine(value => !!(value.title || value.summary), 'A quote preview needs a title or summary')
export type ProjectQuotePreview = z.output<typeof ProjectQuotePreview>

export const ProjectMessage = z.strictObject({
  projectId: id, messageId: id, actorId: id.nullable(), text: z.string().trim().min(1).max(26000),
  quoted: z.string().max(16000).default(''),
  quotedPreview: ProjectQuotePreview.optional(),
  reviewId: id.optional(),
  sentAt: z.iso.datetime().optional(),
  nativeMessageId: id.optional(),
  replyToNativeMessageId: id.optional(),
  quotedDocumentLinks: z.array(z.url({ protocol: /^https$/ }).max(600)).min(1).max(3).optional(),
  sourceUrl: z.url({ protocol: /^https?$/ }).optional(),
  attachments: z.array(MessageAttachment).max(maxProjectAttachments).optional(),
  attachmentOnly: z.literal(true).optional(),
  mentions: z.strictObject({ members: z.array(z.strictObject({ memberId: id, name: z.string().min(1).max(200) })).max(50),
    unresolvedCount: z.number().int().min(0).max(50) }).optional(),
  channel: z.strictObject({ source: id, thread: id, address: z.record(z.string(), z.string()) }),
})
export type ProjectMessage = z.output<typeof ProjectMessage>
export const projectMessageReceived: ProjectEventDefinition = {
  type: 'project.message.received', category: 'messages', schema: ProjectMessage,
  description: '项目消息唤起 Agent，结合原文、引用、当前任务及成员信息选择项目工具并回告结果。',
  defaults: { enabled: true, instruction: '理解成员这次请求及其引用，结合当前项目和已有分工选择工具。明确的修改直接处理，验收条件可根据已有目标拟定。需要补充的信息只问一个具体问题。以实际工具结果说明变化，按用户意图决定是否执行任务。' },
  documentation: 'docs/events/communication.zh-CN.md',
}

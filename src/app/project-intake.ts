import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { ProjectMessage } from '../sources/project-message.ts'
import type { ProjectAgent } from './project-agent.ts'
import type { ProjectPlanning } from './project-planning.ts'
import type { ProjectInput, Projects } from './projects.ts'

/** Explicit onboarding commands for a configured intake conversation. Ordinary discussion goes to the Agent. */
export function enrollmentIntent(text: string): 'self' | 'help' | undefined {
  const message = text.replace(/[。！？!?]+$/u, '').trim()
  if (/^(?:登记项目成员|(?:请)?(?:帮我|给我|把我|将我)\s*(?:登记(?:加入(?:项目)?|为(?:本|这个)?项目成员)?|加入(?:本|这个)?项目)|我要(?:登记(?:为)?项目成员|加入(?:本|这个)?项目))$/u.test(message)) return 'self'
  if (/^(?:请问[，,：:\s]*)?(?:(?:这个群|本群|群里)的?成员|项目成员|群成员)?\s*(?:如何|怎么|怎样)(?:登记(?:为?项目成员)?(?:上来)?|加入(?:本|这个)?项目)(?:呢|呀|吗)?$/u.test(message)) return 'help'
}

export const isMeetingMinutes = (text: string) => /^项目会议纪要(?:[：:]|\r?\n)/u.test(text)
export const meetingFeedback = /^会议反馈[：:]/u
export const meetingClarification = '补充时请 @ 我发「会议反馈：…」。'

export function meetingEvidence(trigger: Trigger, name: string, memberId?: string) {
  return { triggerId: trigger.id, source: trigger.source, name, at: trigger.at, memberId,
    messageId: typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined }
}

export type IntakeBinding = Pick<ProjectInput, 'dingTalkGroup' | 'feishuChatId' | 'conversationBindings'>

export function submitFirstProjectMinutes(planning: ProjectPlanning, trigger: Trigger, binding: IntakeBinding,
  name: string, memberId?: string): string {
  if (trigger.text.length > 26_000) return '会议纪要超过 26,000 字，请缩短后重发。'
  if (!memberId) return '请先 @ 我发「登记项目成员」，再提交会议纪要。'
  const names = [...trigger.text.matchAll(/^项目名称[：:][ \t]*(.*)$/gm)]
  const projectName = names[0]?.[1]?.trim()
  if (names.length !== 1 || !projectName || projectName.length > 200) return '团队确认项目名称后，请在纪要里保留一行「项目名称：…」。'
  const repositories = [...trigger.text.matchAll(/^GitHub 仓库[：:][ \t]*(.*)$/gim)]
  const repositoryHelp = '如果会议已确定 GitHub 仓库，请在同一行填写一个 owner/repo 或 GitHub 仓库链接。'
  if (repositories.length > 1) return repositoryHelp
  const raw = repositories[0]?.[1]?.trim()
  try {
    const result = planning.submitFirstMinutes({ name: projectName, repository: raw && raw !== '无' ? raw : null, ...binding }, {
      ...meetingEvidence(trigger, name, memberId), text: trigger.text, channel: trigger.channel,
      clarificationHint: meetingClarification,
    })
    return result ? `已建立「${result.name}」，当前待开工。正在整理本次会议的分工。` : '当前成员未能提交会议纪要。'
  } catch (error) {
    if (error instanceof z.ZodError) return repositoryHelp
    throw error
  }
}

export function submitProjectConversation(agent: ProjectAgent, projects: Projects, projectId: string, actorId: string,
  scope: string, message: Omit<z.input<typeof ProjectMessage>, 'projectId' | 'actorId' | 'mentions'>, mentioned: readonly (string | null)[] = []) {
  const members = new Map<string, { memberId: string; name: string }>()
  let unresolvedCount = 0
  for (const id of new Set(mentioned.slice(0, 50))) {
    const person = id && projects.directoryMemberForAccount(message.channel.source, scope, id)
    if (person) members.set(person.id, { memberId: person.id, name: person.name })
    else unresolvedCount++
  }
  return agent.submit({ ...message, projectId, actorId,
    ...(members.size || unresolvedCount ? { mentions: { members: [...members.values()], unresolvedCount } } : {}) })
}

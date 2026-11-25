/** Project operations exposed to the management Agent, using the same domain methods as the board. */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { KV } from '../kv.ts'
import type { ChannelRef } from '../core/index.ts'
import { ProgressInput, ProjectChange, ProjectError, Projects, TaskInput, type ProjectDetail } from './projects.ts'
import type { ProjectTracking } from './project-tracking.ts'
import type { ProjectIssues } from './project-issues.ts'
import type { Store } from './store.ts'
import { ReviewInput, TaskDelivery, type ProjectReviews } from './project-reviews.ts'
import { isProjectAgent } from './project-member.ts'
import { deliveryReviewState } from './project-deliveries.ts'
import { CommunicationPreference, type Communication } from './communication.ts'
import type { ProjectProgress } from './project-progress.ts'
import { taskRemoteFacts } from './repository-delivery.ts'
import type { ProjectEvent } from '../sources/project-events.ts'
import { RepositoryFeedback } from '../sources/repository-events.ts'
import { explicitProjectMention, projectChannel } from './project-notifications.ts'
import { readConversation, searchConversation } from './project-conversation-history.ts'
import type { ExecutionMaterials } from './project-references.ts'

const id = z.string().min(1).max(128)
const editable = TaskInput.omit({ status: true, ticketId: true, executionMode: true })
const patch = z.strictObject(Object.fromEntries(Object.entries(editable.shape)
  .map(([key, value]) => [key, (value instanceof z.ZodDefault ? value.removeDefault() : value).optional()])) as Record<string, z.ZodType>)
  .refine(value => Object.values(value).some(item => item !== undefined), 'Supply at least one task field')

export interface ProjectToolContext {
  projectId: string
  /** Null identifies the trusted local management API operator. Group requests always carry a member ID. */
  actorId: string | null
  messageId: string
  operationId: string
  channel: ChannelRef
  reviewId?: string
  text?: string
  event?: ProjectEvent
  /** Original files and links resolved for this turn by the project Agent. */
  executionMaterials?: ExecutionMaterials
}
export interface ProjectToolResult { summary: string; data?: unknown; replyChannel?: ChannelRef; replyMention?: string }
export interface ProjectOperation {
  name: string
  description: string
  schema: z.ZodType
  execute(context: ProjectToolContext, args: unknown): ProjectToolResult
}
export interface ProjectToolsHost {
  store: Store
  issues: Pick<ProjectIssues, 'request'>
  reviews: ProjectReviews
  communication: Communication
  capabilities(channel?: ChannelRef): unknown
  knowledgeDir?: string
  authorizeHistory?(context: Pick<ProjectToolContext, 'channel' | 'actorId'>): boolean
  progress?(): ProjectProgress | undefined
  tracking?(): ProjectTracking
  start(projectId: string, taskId: string, revision: number, materials?: ExecutionMaterials): ProjectDetail
  stop(projectId: string, taskId: string, ticketId: string): ProjectDetail
  follow(projectId: string, taskId: string, ticketId: string, text: string, origin?: ProjectEvent, materials?: ExecutionMaterials): ProjectDetail
  reply?(context: ProjectToolContext, taskId: string, url: string, text: string): unknown
}

function operation<S extends z.ZodType>(name: string, description: string, schema: S,
  execute: (context: ProjectToolContext, args: z.output<S>) => ProjectToolResult): ProjectOperation {
  return { name, description, schema, execute: (context, args) => execute(context, args as z.output<S>) }
}

/** Holds executable tool contracts. The Agent chooses and combines operations from the published catalog. */
export class ProjectTools {
  private readonly projects: Projects
  private readonly operations = new Map<string, ProjectOperation>()
  constructor(private readonly host: ProjectToolsHost) {
    this.projects = new Projects(host.store)
    const change = (context: ProjectToolContext, update: ProjectChange['change']) => this.projects.change(context.projectId,
      ProjectChange.parse({ revision: this.projects.detail(context.projectId).revision, change: update }))
    const task = (context: ProjectToolContext, taskId: string) => {
      const found = this.projects.detail(context.projectId).tasks.find(item => item.id === taskId)
      if (!found) throw new ProjectError(404, 'Task does not belong to this project')
      return found
    }
    this.register(operation('project.inspect', '读取当前项目、任务、执行报告、成员及团队目录。', z.strictObject({}), context => ({
      summary: '已读取项目现状', data: this.snapshot(context.projectId, context.channel),
    })))
    if (host.knowledgeDir) {
      const directory = host.knowledgeDir
      this.register(operation('knowledge.read', '读取已配置的本地知识库 Markdown。先读 index.md，再按索引读取页面。path 相对于知识库目录。', z.strictObject({
        path: z.string().min(1).max(500).default('index.md'),
      }), (_context, { path }) => {
        try {
          if (isAbsolute(path) || extname(path) !== '.md') throw new Error()
          const root = realpathSync(directory)
          const file = realpathSync(resolve(root, path))
          const entry = relative(root, file)
          if (entry === '..' || entry.startsWith(`..${sep}`) || isAbsolute(entry) || extname(entry) !== '.md') throw new Error()
          const stat = statSync(file)
          if (!stat.isFile() || stat.size > 32_768) throw new Error()
          return { summary: `已读取知识库页面 ${entry}`, data: { path: file, text: readFileSync(file, 'utf8') } }
        } catch { throw new ProjectError(404, '知识库页面不存在、不在配置目录内，或超过读取大小限制。') }
      }))
    }
    const authorizeHistory = (context: ProjectToolContext) => {
      if (!this.mayReadHistory(context)) throw new ProjectError(403, '无法读取当前会话的历史。')
    }
    const historyAuthor = (actorId: string | null) => actorId === null ? '本地操作者' : host.store.get(KV.projects.member(actorId))?.name ?? null
    this.register(operation('conversation.history.search', '按关键词和可选 UTC 时间范围检索（结巴分词与 BM25 排序）当前项目会话中已保存的消息与已送达回复，最多五条。', z.strictObject({
      query: z.string().trim().min(1).max(120), after: z.iso.datetime().optional(), before: z.iso.datetime().optional(),
    }).refine(({ after, before }) => !after || !before || Date.parse(after) < Date.parse(before), 'after must be earlier than before'), (context, args) => {
      authorizeHistory(context)
      const candidates = searchConversation(host.store, context, args)
      return { summary: `找到 ${candidates.length} 条会话记录`, data: candidates.map(({ actorId, ...entry }) =>
        ({ ...entry, author: historyAuthor(actorId) })) }
    }))
    this.register(operation('conversation.history.read', '按候选消息 ID 或原生引用读取当前会话的原文和相关回复。使用 nextOffset 继续长消息。', z.strictObject({
      messageId: z.string().min(1).max(300), offset: z.number().int().min(0).max(26000).default(0),
    }), (context, { messageId, offset }) => {
      authorizeHistory(context)
      const message = readConversation(host.store, context, messageId, offset)
      if (!message) return { summary: '当前会话未找到该消息', data: null }
      const { actorId, ...entry } = message
      return { summary: '已读取会话原文', data: { ...entry, author: historyAuthor(actorId) } }
    }))
    this.register(operation('runtime.inspect', '读取真实运行能力、消息通道、格式支持、最近成功发送的实际格式和原生审批限制；不能修改权限或假装已查阅外部文档。', z.strictObject({}), context => ({
      summary: '已读取运行能力', data: host.capabilities(context.channel),
    })))
    this.register(operation('progress.record', '追加成员报告或当前项目 Agent 实际完成的任务进展。可记录卡点、证据和本人上次报告的 corrects。等待依赖时也能记录准备工作。计划或猜测不能当成成果。',
      ProgressInput.extend({ taskId: id }), (context, { taskId, ...input }) => ({
        summary: '已记录任务进展。', data: this.projects.recordProgress(context.projectId, taskId, input, {
          actorId: context.actorId, messageId: context.messageId, source: context.event && context.actorId ? 'agent' : context.channel.source,
          ...(context.text && !context.event ? { original: context.text } : {}),
        }),
      })))
    this.register(operation('tracking.request', '成员明确要求检查并跟进任务进展时，发起指定任务的进展检查。只查状态直接回答；任务指代不清楚时追问。立即通知指定成员用 conversation.mention。只登记检查，不能承诺提醒已送达。',
      z.strictObject({ taskId: id, focus: z.string().trim().max(2000).default('') }), (context, { taskId, focus }) => {
        if (!host.tracking) throw new ProjectError(409, '进展跟进服务尚未启动。')
        const event = host.tracking().request(context, taskId, focus)
        return { summary: '已登记进展检查，是否跟进以实际记录为准。', data: { eventId: event.id, taskId } }
      }))
    this.register(operation('conversation.mention', '群成员本条消息明确要求立即 @ 或通知一名项目成员时，给最终的群回复附加原生提及。memberId 来自项目成员，指代不明时先问清。仅在正文提到姓名或建议下一步时直接回复。', z.strictObject({ memberId: id }),
      (context, { memberId }) => {
        if (context.event) throw new ProjectError(403, '群内显式 @ 需要成员在当前消息中提出。')
        try {
          const target = explicitProjectMention(host.store, context.projectId, context.channel, memberId)
          return { summary: `本条回复将尝试原生 @「${target.address.mentionUserName}」。`, replyMention: memberId }
        } catch (error) {
          if (!(error instanceof ProjectError)) throw error
          return { summary: error.message }
        }
      }))
    this.register(operation('follow_up.schedule', '为当前任务预约一次后续检查；到时由事件唤起 Agent，而非持续扫描。每个任务保留一个预约，新预约替换旧预约；自动推进须已授权。',
      z.strictObject({ taskId: id, at: z.iso.datetime(), reason: z.string().trim().min(1).max(2000) }), (context, args) => {
        task(context, args.taskId)
        const progress = host.progress?.()
        if (!progress) throw new ProjectError(409, 'Autonomous follow-up is unavailable')
        return { summary: '已保存一次后续检查预约', data: progress.schedule(context.projectId, args.taskId, args.at, args.reason, context.operationId) }
      }))
    this.register(operation('follow_up.cancel', '取消当前任务尚待处理的检查预约。', z.strictObject({ taskId: id }), (context, args) => {
      task(context, args.taskId)
      host.progress?.()?.cancel(context.projectId, args.taskId)
      return { summary: '已取消检查预约' }
    }))
    this.register(operation('conversation.preferences.inspect', '读取当前会话已保存的沟通偏好及修订号；会话偏好独立于项目保存。', z.strictObject({}), context => ({
      summary: '已读取本会话沟通偏好', data: host.communication.read(context.channel),
    })))
    this.register(operation('conversation.preferences.update', '根据成员明确要求持久保存当前会话的格式和风格偏好。仅影响本会话；不是任务变更，也不改变执行权限。',
      z.strictObject({ revision: z.number().int().nonnegative(), value: CommunicationPreference }), (context, args) => ({
        summary: '会话偏好更新已登记；确认保存结果后再承诺后续生效。', data: host.communication.update(context, args.revision, args.value),
      })))
    this.register(operation('member.add', '把团队目录中已有的成员加入当前项目。', z.strictObject({ memberId: id }), (context, args) => {
      const result = change(context, { kind: 'add-member', memberId: args.memberId })
      return { summary: `已将「${result.members.find(member => member.id === args.memberId)!.name}」加入项目` }
    }))
    this.register(operation('task.create', '新建一项任务。执行方式、人员、验收条件和依赖均由参数明确指定。', editable, (context, args) => {
      const result = change(context, { kind: 'task', value: args })
      const created = result.tasks.at(-1)!
      return { summary: `已创建「${created.title}」`, data: created }
    }))
    this.register(operation('task.update', '修改现有任务，包括验收条件、分工、执行方式、截止日期和依赖。只改变提供的字段。',
      z.strictObject({ taskId: id, changes: patch }), (context, args) => {
        const current = task(context, args.taskId)
        const fields = Object.fromEntries(Object.entries(args.changes).filter(([, value]) => value !== undefined))
        const active = this.projects.detail(context.projectId).tickets.some(item => !item.ended && (item.id === current.ticketId || item.taskId === current.id))
        if (active && ['title', 'description', 'acceptance', 'executionMode', 'blockedBy', 'deliveryMode', 'pullRequestUrl', 'targetBranch'].some(field => field in fields))
          throw new ProjectError(409, 'This task is executing. Stop the current execution before changing its delivery scope.')
        const result = change(context, { kind: 'task', id: args.taskId, value: { ...TaskInput.strip().parse(current), ...fields } })
        return { summary: `已更新「${current.title}」`, data: result.tasks.find(item => item.id === args.taskId) }
      }))
    this.register(operation('project.update', '更新项目说明、目标或推进状态。开工与任务派工是独立操作，可在同一批工具调用中完成。',
      z.strictObject({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(20000).optional(),
        objective: z.string().max(20000).optional(), status: z.enum(['planning', 'active', 'paused']).optional(), autoAdvance: z.boolean().optional() })
        .refine(value => Object.keys(value).length > 0, 'Supply at least one project field'), (context, args) => {
        const current = this.projects.detail(context.projectId)
        const fields = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
        const result = change(context, { kind: 'project', value: { name: current.name, description: current.description,
          objective: current.objective, status: current.status, ...fields } })
        return { summary: `已更新项目「${result.name}」`, data: { status: result.status, objective: result.objective, autoAdvance: result.autoAdvance } }
      }))
    this.register(operation('task.start', '登记任务已经开始，可与实际进展一起提交。负责人、项目开工和依赖条件由服务端核对。',
      z.strictObject({ taskId: id }), (context, { taskId }) => {
        const project = this.projects.detail(context.projectId)
        if (context.event) {
          const target = task(context, taskId)
          const agentOwned = isProjectAgent(project.members.find(member => member.id === target.ownerId))
          if (target.reviewOf || target.executionMode !== 'agent' && !agentOwned)
            throw new ProjectError(403, '自动开工只适用于指派给项目 Agent 的普通任务。')
        }
        const started = this.projects.beginTask(project.id, taskId, project.revision, context.actorId).tasks.find(item => item.id === taskId)!
        return { summary: `「${started.title}」已在进行中`, data: { taskId, status: started.status } }
      }))
    this.register(operation('execution.start', '按需调用后台 Worker，适用于仓库工作区、执行命令或可恢复运行。保留原负责人；能在当前处理完成的工作可直接提交进展或结果。',
      z.strictObject({ taskId: id }), (context, args) => {
        const current = task(context, args.taskId)
        const project = this.projects.detail(context.projectId)
        const agentOwned = isProjectAgent(project.members.find(member => member.id === current.ownerId))
        if (context.event && (current.reviewOf || current.executionMode !== 'agent' && !agentOwned))
          throw new ProjectError(403, '自动派发只适用于指派给项目 Agent 的任务。')
        if (context.actorId !== null && current.executionMode === undefined && !agentOwned && current.ownerId !== context.actorId)
          throw new ProjectError(403, '请由任务负责人委托后台执行。')
        const result = host.start(context.projectId, args.taskId, project.revision, context.executionMaterials)
        const started = result.tasks.find(item => item.id === args.taskId)!
        return { summary: `已为「${started.title}」登记 Agent 执行`, data: { taskId: started.id, ticketId: started.ticketId, status: started.status } }
      }))
    this.register(operation('task.stop', '停止任务当前工单。保留已经产生的结果和历史。', z.strictObject({ taskId: id }), (context, args) => {
      const current = task(context, args.taskId)
      if (!current.ticketId) throw new ProjectError(409, 'Task has no execution ticket')
      host.stop(context.projectId, current.id, current.ticketId)
      return { summary: `已停止「${current.title}」的当前执行` }
    }))
    this.register(operation('task.follow_up', '向该任务正在执行的 Agent 补充上下文或回答阻塞问题。',
      z.strictObject({ taskId: id, text: z.string().trim().min(1).max(8000) }), (context, args) => {
        const current = task(context, args.taskId)
        if (!current.ticketId) throw new ProjectError(409, 'Task has no execution ticket')
        if (context.event) {
          const feedback = RepositoryFeedback.safeParse(context.event.data)
          if (feedback.success) {
            host.follow(context.projectId, current.id, current.ticketId, args.text, context.event)
            return { summary: `已将补充信息交给「${current.title}」的执行 Agent`, replyChannel: projectChannel(host.store, this.projects.detail(context.projectId)) }
          }
        }
        host.follow(context.projectId, current.id, current.ticketId, args.text, undefined, context.executionMaterials)
        return { summary: `已将补充信息交给「${current.title}」的执行 Agent` }
      }))
    this.register(operation('discussion.reply', '根据成员要求向当前任务已关联的代码交付或评审线程回复。只登记可靠投递，实际发送以回执为准；不能自行猜测其他仓库的地址。',
      z.strictObject({ taskId: id, url: z.url(), text: z.string().trim().min(1).max(8000) }), (context, args) => {
        task(context, args.taskId)
        if (!host.reply) throw new ProjectError(409, 'Repository discussion replies are unavailable')
        return { summary: '讨论回复已登记，实际投递以回执为准。', data: host.reply(context, args.taskId, args.url, args.text),
          ...(context.event ? { replyChannel: projectChannel(host.store, this.projects.detail(context.projectId)) } : {}) }
      }))
    this.register(operation('delivery.submit', '提交实际任务成果和证据，让原任务进入待验证。仅历史关联验收任务在此工具填写 outcome；通常使用 review.decide 记录结论。',
      TaskDelivery.extend({ taskId: id }), (context, { taskId, ...evidence }) => ({
        summary: '提交已登记，状态以事件处理结果为准。', data: host.reviews.deliver(context, taskId, evidence, context.reviewId),
      })))
    this.register(operation('review.decide', '在原任务的指定交付版本记录人工验证反馈（feedback）、通过或退回。反馈保留待验证状态。仅当任务负责人明确代录时提供实际验证人的 reviewerName。引用旧版时不得替换为新版；禁止自行宣布通过。',
      ReviewInput.extend({ taskId: id, reviewId: id }),
      (context, args) => ({ summary: '验证记录已登记，状态以事件处理结果为准。',
        data: host.reviews.decide({ ...context, replyOwner: 'agent' }, args.taskId, args.reviewId, args.outcome, args.reason,
          context.reviewId, args.links, args.reviewerName) })))
    this.register(operation('issue.create', '为当前任务建立或取回 GitHub Issue。使用项目绑定仓库，创建结果通过现有可靠队列回写。',
      z.strictObject({ taskId: id }), (context, args) => {
        const current = task(context, args.taskId)
        const result = host.issues.request({ projectId: context.projectId, taskId: current.id, actorId: context.actorId,
          messageId: context.operationId, channel: context.channel })
        return { summary: result ?? `正在为「${current.title}」创建 Issue`, data: { taskId: current.id, issueUrl: current.issueUrl } }
      }))
  }

  reviewReference(projectId: string, quoted: string): string | undefined { return this.host.reviews.reference(projectId, quoted) }

  mayReadHistory(context: Pick<ProjectToolContext, 'channel' | 'actorId'>): boolean {
    return this.host.authorizeHistory?.(context) ?? true
  }

  register(tool: ProjectOperation): void {
    if (this.operations.has(tool.name)) throw new Error(`Project tool already registered: ${tool.name}`)
    this.operations.set(tool.name, tool)
  }

  catalog() {
    return [...this.operations.values()].map(tool => ({ name: tool.name, description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { io: 'input' }) }))
  }

  snapshot(projectId: string, channel?: ChannelRef) {
    const project = this.projects.detail(projectId)
    const tasks = project.tasks.map(({ progress, ...task }) => ({ ...task, deliveryReview: deliveryReviewState(task, project.tasks),
      ...(progress?.length ? { progress: progress.slice(-5)
        .map(({ original: _original, ...record }) => ({ ...record, summary: record.summary.slice(0, 1000) })) } : {}) }))
    return { now: new Date().toISOString(), project: { ...project, tasks }, directory: this.projects.members().map(({ id, name }) => ({ id, name })), capabilities: this.host.capabilities(channel),
      conversationPreference: channel ? this.host.communication.read(channel) : undefined,
      scheduledChecks: this.host.progress?.()?.checks(projectId) ?? [],
      repositoryFacts: project.tasks.flatMap(task => taskRemoteFacts(this.host.store, project, task).map(fact => ({ taskId: task.id, ...fact }))),
      repositoryFeedback: this.host.store.keys(KV.projects.feedback).map(entry => this.host.store.get(entry)!)
        .filter(feedback => feedback.projectId === projectId).sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0, 20)
        .map(({body, diff, ...feedback}) => ({...feedback, body: body.slice(0,1500), bodyChars: body.length,
          ...(diff ? {diff:diff.slice(0,1000),diffChars:diff.length} : {})})),
      synchronization: this.host.store.keys(KV.projects.issueSync).map(entry => this.host.store.get(entry)!).filter(item => item.projectId === projectId) }
  }

  authorize(context: Pick<ProjectToolContext, 'projectId' | 'actorId' | 'channel'>): void {
    const project = this.projects.detail(context.projectId)
    if (context.actorId === null && context.channel.source === 'request') return
    if (!context.actorId || !project.memberIds.includes(context.actorId)) throw new ProjectError(403, '请先登记为这个项目的成员。')
    if ((context.channel.source === 'dingtalk' && context.channel.address.conversationId !== project.dingTalkGroup)
      || (context.channel.source === 'feishu' && context.channel.address.chatId !== project.feishuChatId))
      throw new ProjectError(403, '这条消息来自另一个项目群。')
  }

  execute(name: string, args: unknown, context: ProjectToolContext): ProjectToolResult {
    this.authorize(context)
    const tool = this.operations.get(name)
    if (!tool) throw new ProjectError(400, `Unknown project tool: ${name}`)
    return tool.execute(context, tool.schema.parse(args))
  }
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DWClient } from 'dingtalk-stream'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import type { CalendarExecutor } from '../src/app/project-calendar.ts'
import type { ProjectAgentRun } from '../src/app/project-agent.ts'
import type { ProjectPlanner } from '../src/app/project-planning.ts'
import { materialReference, resolveProjectReferences } from '../src/app/project-references.ts'
import { obsoleteExplicitProjectMention } from '../src/app/project-notifications.ts'
import { MemberInput, ProjectChange, ProjectInput, Projects } from '../src/app/projects.ts'
import { projectMessageReceived } from '../src/sources/project-message.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { DingTalk, dingTalkKind } from '../src/sources/dingtalk.ts'
import { dingTalkProjectIntake } from '../src/sources/dingtalk.ts'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })
const call = (tool: string, args: unknown) => ({ tool, arguments: JSON.stringify(args) })
const done = (reply = '已处理，请查看任务。') => ({ calls: [], reply })
async function pilot(knowledgeDir?: string, proposeWithImage?: ProjectPlanner['proposeWithImage'], calendar?: CalendarExecutor) {
  const propose = vi.fn(async (_prompt: string, _schema: object, _signal: AbortSignal): Promise<unknown> => done())
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Test Agent', propose, proposeWithImage }, knowledgeDir, calendar)
  const projects = new Projects(h.runtime.store)
  const { id } = projects.create(ProjectInput.parse({ name: '2048 事件验收', status: 'planning', dingTalkGroup: 'test-group', autoAdvance: false }))
  projects.addDingTalkSender(id, 'test-corp', 'member', 'Robin')
  const member = projects.detail(id).members[0]!
  const assignee = projects.registerDingTalkSender('test-corp', 'assignee', '李顺阳').member
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  const task = change({ kind: 'task', value: { title: '整理首版规则', description: '提交规则清单', acceptance: '列出移动和合并规则', executionMode: 'agent', ownerId: member.id } }).tasks[0]!
  const say = async (messageId: string, text: string, quoted = '') => {
    const response = await h.api('POST', `projects/${id}/messages`, { messageId, text, quoted })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    await h.runtime.idle()
    return h.runtime.projectAgent!.runs(id).find(run => run.message.messageId === messageId)!
  }
  return { h, projects, id, member, assignee, task, change, propose, say }
}

it('uses the screenshot request and quote to add acceptance criteria and assignment without dispatching work', async () => {
  const { h, projects, id, assignee, task, propose, say, change } = await pilot()
  const agent = change({ kind: 'add-agent' }).members.find(member => member.accounts.some(account => account.provider === 'agent'))!
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('请你帮忙梳理 验收通过条件并分派给 李顺阳')
    expect(prompt).toContain('整理开发测试用例')
    expect(prompt).toContain(assignee.id)
    expect(prompt).toContain('task.create')
    return { calls: [call('member.add', { memberId: assignee.id }), call('task.create', { title: '整理开发测试用例',
      description: '整理普通合并、连续相同数字、无效移动、结束与重开的用例', acceptance: '每条列明初始棋盘、操作、预期棋盘和计分变化',
      ownerId: agent.id, blockedBy: [task.id] })], reply: '' }
  }).mockImplementationOnce(async prompt => {
    expect(prompt).toContain('已创建「整理开发测试用例」')
    return done('已补充测试用例的验收条件，由李顺阳验收。')
  })
  const run = await say('screenshot', '请你帮忙梳理 验收通过条件并分派给 李顺阳',
    '整理开发测试用例由 Agent 执行、李顺阳验收。需要覆盖哪些内容，以什么条件验收？')
  expect(run.status).toBe('completed')
  expect(projects.detail(id)).toMatchObject({ status: 'planning', autoAdvance: false, tickets: [], tasks: [task,
    { title: '整理开发测试用例', status: 'todo', ownerId: agent.id, blockedBy: [task.id] }] })
  expect(run.steps[0]?.results).toHaveLength(2)
  expect(h.runtime.projectEvents.list({ projectId: id }).map(event => event.type)).toContain('project.message.received')
  const history = await h.api('GET', `projects/${id}/agent-runs`)
  expect(history).toMatchObject({ status: 200, body: [{ status: 'completed', steps: [{ results: [expect.anything(), expect.objectContaining({ summary: '已创建「整理开发测试用例」' })] }] }] })
})

it('handles expressions with no project keywords and changes only supplied task fields', async () => {
  const { projects, id, assignee, task, propose, say } = await pilot()
  propose.mockResolvedValueOnce({ calls: [call('member.add', { memberId: assignee.id }),
    call('task.update', { taskId: task.id, changes: { ownerId: assignee.id, acceptance: '检查四个相同数字的合并与计分' } })], reply: '' })
  const run = await say('plain-language', '这块交给顺阳，四个一样的数字也算一下。', `「${task.title}」由 Agent 执行，Robin 验收。`)
  expect(run.status).toBe('completed')
  expect(projects.detail(id).tasks[0]).toMatchObject({ id: task.id, description: task.description, status: 'todo',
    executionMode: 'agent', ownerId: assignee.id, acceptance: '检查四个相同数字的合并与计分' })
  expect(projects.detail(id).tickets).toEqual([])
})

it('lets the Agent explain or ask a question without creating or starting a task', async () => {
  const { projects, id, propose, say } = await pilot()
  const before = projects.detail(id).revision
  propose.mockResolvedValueOnce(done('你希望李顺阳负责执行，还是继续由 Agent 执行、李顺阳验收？'))
  const run = await say('question', '这个让顺阳来吧')
  expect(run.reply).toContain('负责执行')
  expect(run.steps).toEqual([])
  expect(projects.detail(id).revision).toBe(before)
  expect(projects.detail(id).tickets).toEqual([])
  expect(propose).toHaveBeenCalledOnce()
})

it('rolls back an entire tool batch and returns the failure to the Agent before replying', async () => {
  const { projects, id, task, propose, say } = await pilot()
  propose.mockResolvedValueOnce({ calls: [call('task.update', { taskId: task.id, changes: { acceptance: 'changed' } }),
    call('task.update', { taskId: task.id, changes: { ownerId: 'unknown-member' } })], reply: '' })
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('这批操作已回滚')
    return done('指定的人还不是项目成员，请确认人员。')
  })
  const run = await say('rollback', '调整验收条件并指派')
  expect(projects.detail(id).tasks[0]?.acceptance).toBe(task.acceptance)
  expect(run.steps[0]?.results).toEqual([])
  expect(run.steps[0]?.error).toContain('回滚')
  expect(run.reply).not.toContain('本次实际操作')
})

it('reconsiders a stale proposal using current context instead of committing old tool calls', async () => {
  const { h, projects, id, change, propose } = await pilot()
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise).mockImplementationOnce(async prompt => {
    expect(prompt).toContain('Changed while thinking')
    return done('已根据更新后的目标重新判断。')
  })
  await h.api('POST', `projects/${id}/messages`, { messageId: 'stale', text: '帮我重新安排' })
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  change({ kind: 'project', value: { name: projects.detail(id).name, status: 'planning', objective: 'Changed while thinking' } })
  pending.resolve({ calls: [call('task.create', { title: 'Outdated work' })], reply: '' })
  await h.runtime.idle()
  expect(projects.detail(id).tasks).toHaveLength(1)
  expect(h.runtime.projectAgent!.runs(id)[0]).toMatchObject({ status: 'completed', conflicts: 1 })
  expect(h.runtime.projectEvents.list({ projectId: id }).some(event => event.reason?.includes('Project changed'))).toBe(true)
})

it('starts work through normal project tools and reuses the same run on request redelivery', async () => {
  const { h, projects, id, task, propose, say } = await pilot()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  propose.mockResolvedValueOnce({ calls: [call('project.update', { status: 'active' }), call('execution.start', { taskId: task.id })], reply: '' })
  const run = await say('start', '项目开工，先让 Agent 做规则整理')
  expect(run.status).toBe('completed')
  expect(projects.detail(id)).toMatchObject({ status: 'active', tasks: [{ status: 'in-progress' }], tickets: [expect.objectContaining({ taskId: task.id })] })
  await say('start', '项目开工，先让 Agent 做规则整理')
  expect(projects.detail(id).tickets).toHaveLength(1)
  expect(propose).toHaveBeenCalledTimes(2)
})

it('preserves dependency gates and rolls back kickoff when dispatch fails', async () => {
  const { projects, id, change, task, propose, say } = await pilot()
  const downstream = change({ kind: 'task', value: { title: 'Dependent work', executionMode: 'agent', blockedBy: [task.id] } }).tasks[1]!
  propose.mockResolvedValueOnce({ calls: [call('project.update', { status: 'active' }), call('execution.start', { taskId: downstream.id })], reply: '' })
  const run = await say('blocked-dispatch', '先开始第二项')
  expect(run.steps[0]?.error).toBeTruthy()
  expect(projects.detail(id)).toMatchObject({ status: 'planning', tickets: [] })
})

it('distinguishes an active blocker from a delivered version awaiting verification', async () => {
  const { h, projects, id, member, assignee, change, propose, say } = await pilot()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  change({ kind: 'project', value: { name: projects.detail(id).name, status: 'active' } })
  change({ kind: 'add-member', memberId: assignee.id })
  const upstream = change({ kind: 'task', value: { title: '交付候选版本', executionMode: 'agent', ownerId: assignee.id } }).tasks[1]!
  const downstream = change({ kind: 'task', value: { title: '人工试用', executionMode: 'manual', ownerId: member.id, blockedBy: [upstream.id] } }).tasks[2]!
  const revision = projects.detail(id).revision
  const started = await h.api('POST', `projects/${id}/tasks/${upstream.id}/run`, { revision })
  expect(started.status).toBe(200)
  await h.runtime.idle()
  const ticketId = projects.detail(id).tasks[1]!.ticketId!
  const question = '请 Robin 在真机上验证并提供截图。'
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'blocked', summary: '规则测试已通过', human_action: question })
  await h.runtime.idle()

  propose.mockImplementationOnce(async prompt => {
    const context = JSON.parse(prompt.split('\n\n').at(-1)!).projectContext.project
    expect(context.tasks[2]).toMatchObject({ id: downstream.id, blockedBy: [upstream.id], status: 'todo' })
    expect(context.tasks[1]).toMatchObject({ status: 'in-progress', deliveryReview: { status: 'not-requested', reviewerId: null } })
    expect(context.tickets).toContainEqual(expect.objectContaining({ id: ticketId, stage: 'person', action: 'answer', question }))
    expect(prompt).toContain('只有 deliveryReview.status=pending 才说正在等该版验收')
    return done('当前等 Robin 回传真机验证，交付尚未发起验收。')
  })
  const blocked = await say('wait-for-evidence', '人工试用目前具体在等谁？只查询。')
  expect(blocked).toMatchObject({ status: 'completed', steps: [], reply: '当前等 Robin 回传真机验证，交付尚未发起验收。' })

  await h.api('POST', `projects/${id}/tasks/${upstream.id}/follow-up`, { ticketId, text: '已补充真机验证和截图' })
  await h.runtime.idle()
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: '已收到验证证据，可以验收' })
  await h.runtime.idle()
  const review = projects.detail(id).tasks[1]!.reviews!.at(-1)!
  propose.mockImplementationOnce(async prompt => {
    const context = JSON.parse(prompt.split('\n\n').at(-1)!).projectContext.project
    expect(context.tasks[1]).toMatchObject({ status: 'in-review', deliveryReview: { status: 'pending', reviewId: review.id, reviewerId: null } })
    expect(context.tasks[2]).toMatchObject({ status: 'todo', blockedBy: [upstream.id] })
    return done('交付已提交，等项目成员验证。')
  })
  expect(await say('wait-for-review', '人工试用现在还在等什么？')).toMatchObject({ status: 'completed', steps: [], reply: '交付已提交，等项目成员验证。' })
})

it('uses the selected task repository and links the Issue without dispatching a worker', async () => {
  const { projects, id, task, change, propose, say } = await pilot()
  change({ kind: 'project', value: { name: projects.detail(id).name, repository: 'acme/pilot' } })
  const url = 'https://github.com/acme/pilot/issues/18'
  const api = vi.spyOn(Commands.prototype, 'gh').mockResolvedValue({ html_url: url })
  try {
    propose.mockResolvedValueOnce({ calls: [call('issue.create', { taskId: task.id })], reply: '' })
    const run = await say('issue', '这个先帮我在项目仓库留个 Issue，暂时不要做。', task.title)
    expect(run.status).toBe('completed')
    expect(projects.detail(id).tasks[0]?.issueUrl).toBe(url)
    expect(projects.detail(id).tickets).toEqual([])
    expect(api).toHaveBeenCalledOnce()
    expect(api.mock.calls[0]?.[0]).toContain('repos/acme/pilot/issues')
  } finally { api.mockRestore() }
})

it('recovers a persisted model decision after restart without asking the model to repeat the committed proposal', async () => {
  const { h, projects, id, task } = await pilot()
  const project = projects.detail(id)
  const members = projects.members()
  const runId = 'persisted-project-request'
  const pending: NonNullable<ProjectAgentRun['pending']> = { runId, turn: 0, revision: project.revision, provider: 'Before restart',
    decision: { calls: [call('task.update', { taskId: task.id, changes: { acceptance: '恢复后保留的具体条件' } })], reply: '' } }
  const run: ProjectAgentRun = { id: runId, message: { projectId: id, actorId: null, messageId: 'restart', text: '补充验收条件', quoted: '',
    channel: { source: 'request', thread: id, address: { projectId: id } } }, status: 'running', instruction: '', turn: 0,
    conflicts: 0, steps: [], pending, at: new Date().toISOString() }
  await h.stop(); host = undefined
  const propose = vi.fn(async () => done('已恢复并补充条件。'))
  const resumed = host = await startRuntime(store => {
    store.set(KV.projects.project(id), project)
    for (const member of members) store.set(KV.projects.member(member.id), member)
    store.set(KV.projects.agentRun(runId), run)
    store.db.prepare('INSERT INTO effect (kind,key,value,seq,due,since) VALUES (?,?,?,?,?,?)')
      .run('project-agent', runId, JSON.stringify({ runId }), 1, Date.now(), run.at)
  }, undefined, undefined, undefined, undefined, { name: 'After restart', propose })
  await resumed.runtime.idle()
  expect(new Projects(resumed.runtime.store).detail(id).tasks[0]?.acceptance).toBe('恢复后保留的具体条件')
  expect(resumed.runtime.projectAgent!.runs(id)[0]).toMatchObject({ status: 'completed', steps: [{ provider: 'Before restart' }] })
  expect(propose).toHaveBeenCalledOnce()
})

it('reports model failure after a bounded retry and leaves no silent request', async () => {
  const { h, propose, say, id } = await pilot()
  propose.mockRejectedValue(new Error('provider unavailable'))
  const run = await say('unavailable', '请整理一下')
  expect(run).toMatchObject({ status: 'failed', reply: expect.stringContaining('无法生成有效处理结果') })
  expect(propose).toHaveBeenCalledTimes(2)
  expect(h.runtime.effects.pending('project-agent')).toBe(false)
  expect((await h.api('GET', `projects/${id}/agent-runs`)).body).toMatchObject([{ status: 'failed' }])
})

it('uses configured Agent instructions and supports additional tools through the catalog', async () => {
  const { h, id, propose, say } = await pilot()
  h.runtime.projectTools!.register({ name: 'project.count_tasks', description: 'Count current project tasks', schema: z.strictObject({}),
    execute: context => ({ summary: '已统计任务数量', data: h.runtime.projectTools!.snapshot(context.projectId).project.tasks.length }) })
  expect(await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { 'project.message.received': '每次说明需要谁采取下一步行动。' } } }))
    .toMatchObject({ status: 200 })
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('每次说明需要谁采取下一步行动')
    expect(prompt).toContain('project.count_tasks')
    return { calls: [call('project.count_tasks', {})], reply: '' }
  })
  const run = await say('custom-tool', '现在有多少项？')
  expect(run.steps[0]?.results[0]?.data).toBe(1)
  expect((await h.api('GET', 'projects/tools')).body).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'project.count_tasks' })]))
  expect(h.runtime.projectEvents.view().events.some(event => event.type === 'project.agent.proposed')).toBe(false)
  expect(await h.api('PUT', 'projects/workflow', { revision: 1, config: { on: { 'project.agent.proposed': false } } })).toMatchObject({ status: 400 })
})

it('can disable project message handling with JSON and stops proposals disabled during inference', async () => {
  const { h, id, propose, projects } = await pilot()
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise)
  await h.api('POST', `projects/${id}/messages`, { messageId: 'disable-running', text: '整理一下' })
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { 'project.message.received': false } } })
  pending.resolve({ calls: [call('task.create', { title: 'Should remain uncreated' })], reply: '' })
  await h.runtime.idle()
  expect(projects.detail(id).tasks).toHaveLength(1)
  const response = await h.api('POST', `projects/${id}/messages`, { messageId: 'disabled', text: '再整理一下' })
  expect(response).toMatchObject({ status: 200, body: { status: 'disabled' } })
  await h.runtime.idle()
  expect(propose).toHaveBeenCalledOnce()
  expect(h.runtime.projectEvents.list({ projectId: id })[0]).toMatchObject({ status: 'ignored' })
})

it('continues DingTalk conversation, reads local knowledge, and retains project commands and native quotes', async () => {
  const { h, projects, id, task, propose, say } = await pilot(fileURLToPath(new URL('../docs/', import.meta.url)))
  const send = vi.fn(async () => {})
  const kind = dingTalkKind(send)
  h.runtime.sources.register(kind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } } })
  let receive!: (frame: { headers: { messageId: string }; data: string }) => Promise<void>
  const callback = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, fn) {
    receive = fn as typeof receive; return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  try {
    new DingTalk(h.runtime.context(kind), { clientId: 'test', clientSecret: 'test' }, () => {}, undefined, undefined, undefined,
      dingTalkProjectIntake(projects, h.runtime.projectPlanning, 'test-group', h.runtime.projectAgent))
    propose.mockImplementationOnce(async prompt => {
      expect(prompt).toContain('四个一样的也算一下')
      expect(prompt).toContain(task.title)
      return { calls: [call('task.update', { taskId: task.id, changes: { acceptance: '验证四个相同数字的合并和计分' } })], reply: '' }
    })
    const frame = { headers: { messageId: 'delivery' }, data: JSON.stringify({ msgId: 'no-keywords', conversationId: 'test-group',
      conversationType: '2', isInAtList: true, chatbotUserId: 'bot', senderStaffId: 'member', senderCorpId: 'test-corp',
      robotCode: 'robot', msgtype: 'text', text: { content: '四个一样的也算一下', isReplyMsg: true,
        repliedMsg: { senderId: 'bot', content: `「${task.title}」的说明` } },
      sessionWebhook: 'https://oapi.dingtalk.com/robot/send?fixture', sessionWebhookExpiredTime: Date.now() + 60000 }) }
    await receive(frame); await receive(frame)
    await h.runtime.idle()
    expect(projects.detail(id).tasks[0]?.acceptance).toBe('验证四个相同数字的合并和计分')
    expect(projects.detail(id).tickets).toEqual([])
    expect(h.runtime.projectAgent!.runs(id)).toHaveLength(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '已处理，请查看任务。' }))
    expect(h.runtime.projectAgent!.runs(id)[0]?.steps[0]?.results[0]?.summary).toBe('已更新「整理首版规则」')
    expect(ack).toHaveBeenCalledTimes(2)
    await say('web-only', '这条网页消息不属于钉钉会话')
    const ask = (msgId: string, content: string, senderStaffId = 'member') => receive({ headers: { messageId: msgId },
      data: JSON.stringify({ ...JSON.parse(frame.data), msgId, senderStaffId, text: { content } }) })
    await ask('enrollment-help', '怎么加入这个项目？', 'new-member')
    await h.runtime.idle()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('用发消息的钉钉账号把本人加入这个群绑定的项目'),
    }))
    expect(projects.memberForAccount(id, 'dingtalk', 'test-corp', 'new-member')).toBeUndefined()
    await ask('enrollment-self', '把我登记加入', 'new-member')
    await h.runtime.idle()
    expect(projects.memberForAccount(id, 'dingtalk', 'test-corp', 'new-member')).toBeDefined()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '已加入「2048 事件验收」项目。' }))
    propose.mockImplementationOnce(async prompt => {
      expect(prompt).toContain('knowledge.read')
      return { calls: [call('knowledge.read', { path: 'README.md' })], reply: '' }
    }).mockImplementationOnce(async prompt => {
      expect(prompt).toContain(readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8').split('\n')[0])
      return done('知识库入口是 README。')
    })
    await ask('knowledge-question', '知识库从哪开始读？')
    await h.runtime.idle()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '知识库入口是 README。' }))
    propose.mockImplementationOnce(async prompt => {
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
      expect(context.recentConversation).toContainEqual({ text: '知识库从哪开始读？', reply: '知识库入口是 README。' })
      expect(context.recentConversation.map((turn: { text: string }) => turn.text)).not.toContain('这条网页消息不属于钉钉会话')
      return done('你可以先读目录。')
    })
    await ask('knowledge-followup', '然后呢？')
    await h.runtime.idle()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '你可以先读目录。' }))
    expect(projects.detail(id).tasks).toHaveLength(1)
    expect(projects.detail(id).tickets).toEqual([])
    const deliver = (msgId: string, data: Record<string, unknown>) => receive({ headers: { messageId: msgId },
      data: JSON.stringify({ ...JSON.parse(frame.data), msgId, ...data }) })
    await deliver('observe-new-member', { senderStaffId: 'new-member', senderId: 'opaque-new-member',
      text: { content: '登记项目成员' } })
    await h.runtime.idle()
    const newMember = projects.memberForAccount(id, 'dingtalk', 'test-corp', 'new-member')!
    propose.mockImplementationOnce(async prompt => {
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
      expect(context.message.text).toBe('任务1负责人')
      expect(context.message.mentions).toEqual({ members: [{ memberId: newMember.id, name: newMember.name }], unresolvedCount: 0 })
      return { calls: [call('task.update', { taskId: task.id, changes: { ownerId: newMember.id } })], reply: '' }
    })
    await deliver('mention-assignment', { senderId: 'opaque-member',
      atUsers: [{ dingtalkId: 'bot' }, { dingtalkId: 'opaque-new-member' }], text: { content: '任务1负责人  ' } })
    await h.runtime.idle()
    expect(projects.detail(id).tasks[0]?.ownerId).toBe(newMember.id)
    propose.mockImplementationOnce(async prompt => {
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
      expect(context.message.mentions).toMatchObject({ members: [{ memberId: newMember.id }], unresolvedCount: 1 })
      expect(prompt).toContain('勿按列表顺序猜测')
      return done('请说明这两位分别对应哪项任务。')
    })
    await deliver('ambiguous-mentions', { senderId: 'opaque-member',
      atUsers: [{ dingtalkId: 'bot' }, { dingtalkId: 'opaque-new-member' }, { dingtalkId: 'opaque-unknown' }],
      text: { content: '任务1负责人  ，任务2负责人  ' } })
    await h.runtime.idle()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '请说明这两位分别对应哪项任务。' }))
    const historyTools = h.runtime.projectTools!
    const { message } = h.runtime.projectAgent!.runs(id).find(run => run.message.text === '知识库从哪开始读？')!
    const turn = historyTools.execute('conversation.history.read', { messageId: 'no-keywords' },
      { ...message, operationId: 'dingtalk-history' })
    expect(turn.data).toMatchObject({ text: '四个一样的也算一下', reply: '已处理，请查看任务。' })
    expect(historyTools.execute('conversation.history.read', { messageId: 'no-keywords' }, {
      projectId: id, actorId: null, messageId: 'web', operationId: 'web-read', channel: { source: 'request', thread: id, address: {} },
    }).data).toBeNull()
    expect(() => h.runtime.projectTools!.execute('knowledge.read', { path: '../README.md' }, {
      projectId: id, actorId: null, messageId: 'traversal', operationId: 'traversal',
      channel: { source: 'request', thread: id, address: {} },
    })).toThrow('不在配置目录内')

    const documentUrl = 'https://alidocs.dingtalk.com/i/nodes/example-workflow'
    propose.mockImplementationOnce(async prompt => {
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
      expect(context.message).toMatchObject({ text: '是这个', quoted: '', replyToNativeMessageId: 'never-stored-card',
        quotedDocumentLinks: [documentUrl] })
      expect(context.reference).toEqual({ quote: 'inline', links: [documentUrl] })
      expect(prompt).toContain('无需让成员重发该链接')
      expect(prompt).not.toMatch(/tracking-secret|untrusted\.example|fake-signature/)
      return done('我已识别这份钉钉文档链接。打开正文仍需要文档访问权限。')
    })
    await receive({ headers: { messageId: 'document-card' }, data: JSON.stringify({ ...JSON.parse(frame.data), msgId: 'document-card',
      text: { content: '是这个', isReplyMsg: true, repliedMsg: { msgId: 'never-stored-card', senderId: 'another-bot',
        msgType: 'interactiveCard', content: {
          biz_custom_action_url: `${documentUrl}?tracking-secret#share`,
          cardContent: [{ elementType: 'LINK', value: documentUrl }, { elementType: 'LINK', value: 'https://untrusted.example/doc' },
            { elementType: 'LINK', value: 'https://files.aliyuncs.com/private.pdf?Signature=fake-signature' }],
        } } } }) })
    await h.runtime.idle()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('我已识别这份钉钉文档链接。打开正文仍需要文档访问权限。') }))
    expect(h.runtime.projectAgent!.runs(id)[0]?.steps).toEqual([])
  } finally { callback.mockRestore(); ack.mockRestore() }
})

it('reads quoted DingTalk files and native documents with the sender access, and records only supported progress', async () => {
  const { h, projects, task, id, propose } = await pilot()
  const send = vi.fn()
  const kind = dingTalkKind(async message => { send(message) })
  h.runtime.sources.register(kind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } } })
  let receive!: (frame: { headers: { messageId: string }; data: string }) => Promise<void>
  const callback = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, fn) {
    receive = fn as typeof receive; return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  const link = (id: string) => `https://alidocs.dingtalk.com/i/nodes/${id}`
  const fileUrl = 'https://files.oss-cn-zhangjiakou.aliyuncs.com/workflow.html?Signature=private'
  let directoryDenied = false
  const http = vi.fn(async (address: string | URL, init?: RequestInit) => {
    const url = new URL(address)
    expect(init?.redirect === 'error' || url.pathname.endsWith('/accessToken')).toBe(true)
    if (url.pathname.endsWith('/accessToken')) return Response.json({ accessToken: 'test-app-token' })
    if (url.pathname === '/topapi/v2/user/get') {
      expect(url.origin).toBe('https://oapi.dingtalk.com')
      expect(url.searchParams.get('access_token')).toBe('test-app-token')
      expect(JSON.parse(String(init?.body))).toEqual({ userid: 'member' })
      return directoryDenied ? Response.json({ errcode: 88 }) : Response.json({ errcode: 0, result: { unionid: 'requester-union-id' } })
    }
    if (url.href === fileUrl) {
      expect(init?.headers).toEqual({ 'x-oss-test': 'signature' })
      return new Response('<h1>交付 Workflow</h1><p>已完成五项移动规则测试，触屏测试待验收。</p><script>FORGED_PROGRESS</script>')
    }
    expect(url.origin).toBe('https://api.dingtalk.com')
    expect(new Headers(init?.headers).get('x-acs-dingtalk-access-token')).toBe('test-app-token')
    if (url.pathname.endsWith('/downloadInfos/query')) {
      expect(url.pathname).toBe('/v1.0/storage/spaces/space/dentries/file/downloadInfos/query')
      expect(url.searchParams.get('unionId')).toBe('requester-union-id')
      expect(init?.method).toBe('POST')
      return Response.json({ headerSignatureInfo: { resourceUrls: [fileUrl], headers: { 'x-oss-test': 'signature' } } })
    }
    expect(url.searchParams.get('operatorId')).toBe('requester-union-id')
    if (url.pathname === '/v2.0/wiki/nodes/workflow') return Response.json({
      node: { nodeId: 'workflow', name: 'workflow.html', category: 'DOCUMENT', extension: 'html', type: 'FILE' },
    })
    if (url.pathname === '/v2.0/doc/dentries/workflow/queryDentryId') return Response.json({ spaceId: 'space', dentryId: 'file' })
    if (url.pathname.startsWith('/v2.0/wiki/nodes/')) return Response.json({
      node: { nodeId: url.pathname.split('/').at(-1), name: '验收说明', category: 'ALIDOC', extension: 'adoc', type: 'FILE' },
    })
    if (url.pathname === '/v1.0/doc/suites/documents/private/blocks')
      return Response.json({ code: 'AccessDenied', message: 'private response' }, { status: 403 })
    expect(url.pathname).toBe('/v1.0/doc/suites/documents/native/blocks')
    expect(url.searchParams.get('endIndex')).toBe('100')
    return Response.json({ success: true, result: { data: [
      { blockType: 'paragraph', paragraph: { children: [{ elementType: 'text', text: { content: '重新开始按钮需要小屏核对。' } }] } },
    ] } })
  })
  try {
    const agent = h.runtime.projectAgent!
    const bot = new DingTalk(h.runtime.context(kind), { clientId: 'test', clientSecret: 'test' }, () => {}, http as typeof fetch,
      undefined, undefined, dingTalkProjectIntake(projects, h.runtime.projectPlanning, undefined, agent))
    agent.registerLinkedDocumentReader(kind.kind, bot.linkedDocumentReader('test-corp'))
    const post = async (msgId: string, content: string, document?: string, corpId = 'test-corp', staffId = 'member') => {
      await receive({ headers: { messageId: msgId }, data: JSON.stringify({
        msgId, senderStaffId: staffId, senderCorpId: corpId, conversationId: 'test-group', conversationType: '2',
        isInAtList: true, robotCode: 'test', sessionWebhook: 'https://oapi.dingtalk.com/robot/send?test',
        sessionWebhookExpiredTime: Date.now() + 60_000, msgtype: 'text', text: { content,
          ...(document ? { isReplyMsg: true, repliedMsg: { msgId: 'unknown-card', msgType: 'interactiveCard',
            content: { biz_custom_action_url: document } } } : {}) },
      }) })
      await h.runtime.idle()
      return agent.runs(id).find(run => run.message.nativeMessageId === msgId)
    }
    const contextOf = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
    const progress = '已完成五项移动规则测试，触屏测试待验收。'
    propose.mockImplementationOnce(async prompt => {
      expect(contextOf(prompt)).toMatchObject({ name: 'workflow.html', text: expect.stringContaining(progress) })
      expect(prompt).not.toMatch(/FORGED_PROGRESS|requester-union-id|Signature=private|test-app-token/)
      return { summary: progress }
    }).mockImplementationOnce(async prompt => {
      expect(contextOf(prompt).reference.documents).toEqual([{ link: link('workflow'), name: 'workflow.html', summary: progress, partial: true }])
      return { calls: [call('progress.record', { taskId: task.id, summary: progress, links: [link('workflow')] })], reply: '' }
    }).mockResolvedValueOnce(done('已将五项规则测试和待验收的触屏测试记入任务。'))
    const title = '请根据这份资料更新整理首版规则的进展'
    const imported = await post('html-card', title, `${link('workflow')}?utm_source=card`)
    expect(imported?.reply).toContain('已将五项规则测试')
    const reads = http.mock.calls.length
    await post('html-card', title, link('workflow'))
    expect(http).toHaveBeenCalledTimes(reads)
    expect(imported?.documentResults).toHaveLength(1)
    expect(projects.detail(id).tasks[0]?.progress).toMatchObject([{ summary: progress, links: [link('workflow')] }])

    propose.mockImplementationOnce(async prompt => {
      expect(contextOf(prompt).text).toContain('重新开始按钮需要小屏核对')
      return { summary: '重新开始按钮需要小屏核对。' }
    }).mockImplementationOnce(async prompt => {
      expect(contextOf(prompt).reference.documents).toMatchObject([{ link: link('native'), partial: false }])
      return done('文档正文提到重新开始按钮需要小屏核对。')
    })
    expect((await post('direct-native', `请读这份文档 ${link('native')}`))?.reply).toContain('文档正文提到')

    propose.mockImplementationOnce(async prompt => {
      expect(contextOf(prompt).reference.documents).toEqual([{ link: link('private'), name: '在线文档',
        error: '钉钉拒绝读取文档正文，请检查应用权限和你对该资料的访问权限。' }])
      expect(prompt).not.toContain('private response')
      return done('进展暂未更新。')
    })
    const denied = await post('private-card', title, link('private'))
    expect(denied?.reply).toContain('钉钉拒绝读取文档正文')
    expect(denied?.reply).toContain('在群里上传导出的可访问文件')
    expect(denied?.steps).toEqual([])
    expect(projects.detail(id).tasks[0]?.progress).toHaveLength(1)
    const authorizedReads = http.mock.calls.length
    projects.addDingTalkSender(id, 'outside-corp', 'outsider', '外部项目成员')
    expect((await post('foreign-sender', title, link('native'), 'outside-corp', 'outsider'))?.documentResults)
      .toMatchObject([{ error: '无法验证当前发送者属于已配置的钉钉企业。' }])
    await post('unknown-provider', '顺带看看 https://untrusted.example/doc')
    expect(http).toHaveBeenCalledTimes(authorizedReads)
    directoryDenied = true
    const missingScope = await post('missing-scope', title, link('workflow'))
    expect(missingScope?.reply).toContain('钉钉应用尚未开通成员信息读权限')
    expect(http).toHaveBeenCalledTimes(authorizedReads + 1)
    expect(projects.detail(id).tickets).toEqual([])
  } finally { callback.mockRestore(); ack.mockRestore() }
})

it('resolves an old material link exactly through the web conversation API', async () => {
  const { h, id, say, propose } = await pilot()
  const url = 'https://docs.example.org/workflow'
  const old = await say('old-workflow', `最新版 workflow 在这里：${url}。`)
  for (let i = 0; i < 6; i++) await say(`unrelated-${i}`, `同期无关消息 ${i}`)
  propose.mockImplementationOnce(async prompt => {
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
    expect(context.reference).toEqual({ quote: 'resolved', links: [url], message: { id: old.id, text: old.message.text } })
    expect(context.recentConversation).not.toContainEqual(expect.objectContaining({ id: old.id }))
    return done('我已定位 workflow 链接。')
  })
  const response = await h.api('POST', `projects/${id}/messages`, {
    messageId: 'quote-workflow', text: '这份 workflow', replyToMessageId: 'old-workflow',
  })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const agent = h.runtime.projectAgent!
  const run = agent.runs(id).find(item => item.message.messageId === 'quote-workflow')!
  expect(run.reply).toContain('我已定位 workflow 链接。')
  expect(run.references?.links).toEqual([url])
  const unmatched = { ...run.message, quoted: materialReference(old.id) }
  expect(resolveProjectReferences(h.runtime.store, { ...unmatched, channel: { ...unmatched.channel, thread: 'another-chat' } }, true))
    .toMatchObject({ links: [], attachments: [] })
  expect(resolveProjectReferences(h.runtime.store, { ...unmatched, projectId: 'another-project' }, true))
    .toMatchObject({ links: [], attachments: [] })
  expect(resolveProjectReferences(h.runtime.store, unmatched, false)).toMatchObject({ links: [], attachments: [] })
  expect(resolveProjectReferences(h.runtime.store, { ...unmatched, quoted: '', replyToNativeMessageId: 'unknown-message' }, true))
    .toEqual({ quote: 'unavailable', links: [], attachments: [] })
})

it('loads older web project conversation only through the history tools', async () => {
  const { h, id, projects, propose, say } = await pilot()
  const oldText = '决定：灰度发布先覆盖一个小组。' + '资料'.repeat(2200)
  propose.mockImplementationOnce(async () => done('已记录灰度决定，由首批团队试用。'))
  const older = await say('older-web-history', oldText)
  for (let i = 0; i < 6; i++) await say(`recent-web-${i}`, `近期对话 ${i}`)
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).not.toContain('灰度发布先覆盖')
    return done('你好。')
  })
  expect((await say('routine-web', '你好')).steps).toEqual([])
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).not.toContain('灰度发布先覆盖')
    return { calls: [call('conversation.history.search', { query: '灰度' })], reply: '' }
  }).mockImplementationOnce(async prompt => {
    expect(prompt).toContain(older.id)
    return { calls: [call('conversation.history.read', { messageId: older.id })], reply: '' }
  }).mockImplementationOnce(async prompt => {
    expect(prompt).toContain('灰度发布先覆盖一个小组')
    return done('当时决定先覆盖一个小组。')
  })
  const recalled = await say('web-history-query', '之前确定的灰度发布范围是什么？')
  expect(recalled.reply).toBe('当时决定先覆盖一个小组。')
  const web = await h.api('GET', `projects/${id}/conversation`)
  expect(web).toMatchObject({ status: 200, body: expect.arrayContaining([
    { id: recalled.id, at: expect.any(String), text: '之前确定的灰度发布范围是什么？', reply: '当时决定先覆盖一个小组。', status: 'completed' },
  ]) })
  expect(recalled.steps[0]?.results[0]?.data).toEqual([expect.objectContaining({ messageId: older.id, author: '本地操作者' })])
  expect(recalled.steps[1]?.results[0]?.data).toMatchObject({ text: oldText.slice(0, 4000), nextOffset: 4000 })
  const tools = h.runtime.projectTools!
  const context = { ...recalled.message, operationId: 'history-page' }
  expect(tools.execute('conversation.history.read', { messageId: older.id, offset: 4000 }, context).data)
    .toMatchObject({ text: oldText.slice(4000), nextOffset: null })
  expect(tools.execute('conversation.history.search', { query: '灰度', after: '2100-01-01T00:00:00Z' }, context).data).toEqual([])
  const other = projects.create(ProjectInput.parse({ name: 'Another project' }))
  expect(tools.execute('conversation.history.read', { messageId: older.id }, {
    ...context, projectId: other.id, channel: { source: 'request', thread: other.id, address: {} },
  }).data).toBeNull()
})

it('uses DingTalk attachment previews for progress and hands the original to new and existing workers', async () => {
  const { h, projects, id, member, change, propose } = await pilot()
  change({ kind: 'project', value: { name: '2048 事件验收', status: 'active' } })
  const task = change({ kind: 'task', value: { title: '整理交付材料', ownerId: member.id } }).tasks.at(-1)!
  const send = vi.fn()
  const kind = dingTalkKind(async message => { send(message) })
  h.runtime.sources.register(kind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  const slides = readFileSync(new URL('./fixtures/reordered-slides.pptx', import.meta.url))
  let receive!: (frame: { headers: { messageId: string }; data: string }) => Promise<void>
  const callback = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, fn) {
    receive = fn as typeof receive; return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  const fetchFile = vi.fn(async (url: URL | string, init?: RequestInit) => {
    if (String(url).endsWith('/accessToken')) return Response.json({ accessToken: 'auth-token' })
    if (String(url).endsWith('/messageFiles/download')) {
      const request = JSON.parse(String(init?.body))
      if (request.downloadCode === 'expired-code') return Response.json({ code: 'invalidParameter.robotCode.downloadCode' }, { status: 400 })
      if (request.downloadCode === 'ip-denied') return Response.json({
        code: 'Forbidden.AccessDenied.IpNotInWhiteList', message: 'private-egress-address',
      }, { status: 403 })
      if (request.downloadCode === 'untrusted-code') return Response.json({ downloadUrl: 'http://aliyuncs.com.example.org/handout' })
      if (request.downloadCode === 'slides-code') return Response.json({ downloadUrl: 'https://files.oss-cn-zhangjiakou.aliyuncs.com/slides' })
      expect(request).toEqual({ robotCode: 'robot', downloadCode: 'temporary-file-secret' })
      return Response.json({ downloadUrl: 'http://files.oss-cn-zhangjiakou.aliyuncs.com/handout?Signature=fixture%2Btoken' })
    }
    if (String(url).endsWith('/slides')) return new Response(new Uint8Array(slides))
    expect(String(url)).toBe('https://files.oss-cn-zhangjiakou.aliyuncs.com/handout?Signature=fixture%2Btoken')
    expect(init?.headers).toBeUndefined()
    expect(init?.redirect).toBe('error')
    return new Response('<script>malicious script</script><h1>Slide handout</h1><p>Execution evidence by section.</p>')
  })
  try {
    const agent = h.runtime.projectAgent!
    const bot = new DingTalk(h.runtime.context(kind), { clientId: 'test', clientSecret: 'test' }, () => {}, fetchFile as typeof fetch,
      undefined, undefined, dingTalkProjectIntake(projects, h.runtime.projectPlanning, undefined, agent))
    agent.registerAttachmentReader('dingtalk', (message, attachment, signal) => bot.readProjectAttachment(message, attachment, signal))
    const sourceLink = 'https://docs.example.org/slide-notes'
    const post = async (msgId: string, options: { sender?: string; name?: string; code?: string; summaryCard?: string; link?: string } = {}) => {
      await receive({ headers: { messageId: msgId }, data: JSON.stringify({ msgId, senderStaffId: options.sender ?? 'member', conversationId: 'test-group',
        conversationType: '2', isInAtList: true, senderCorpId: 'test-corp', robotCode: 'robot', chatbotUserId: 'bot', msgtype: 'text',
        text: { content: options.summaryCard ? '请继续处理上面的原件' :
          ['针对整理交付材料的任务，我做了这份文档，请根据文档更新进展', options.link].filter(Boolean).join('\n'),
        isReplyMsg: true, repliedMsg: options.summaryCard
          ? { msgId: 'bot-summary', senderId: 'bot', msgType: 'interactiveCard',
            content: { cardContent: [{ elementType: 'TEXT', value: options.summaryCard }] } }
          : { msgId: 'original-file-not-stored', msgType: 'file',
            content: { fileId: 'attachment-one', fileName: options.name ?? 'handout.html', downloadCode: options.code ?? 'temporary-file-secret' } } },
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?fixture', sessionWebhookExpiredTime: Date.now() + 60_000 }) })
      await h.runtime.idle()
      return agent.runs(id).find(run => run.message.nativeMessageId === msgId)
    }
    propose.mockImplementationOnce(async prompt => {
      expect(prompt).toContain('Execution evidence by section')
      expect(prompt).not.toMatch(/malicious script|temporary-file-secret|task\.begin/)
      return { summary: '材料按章节列出了执行证据。' }
    }).mockImplementationOnce(async prompt => {
      expect(prompt).toContain('"attachments":[{"name":"handout.html","summary":"材料按章节列出了执行证据。"')
      expect(prompt).not.toContain('Execution evidence by section')
      return { calls: [call('progress.record', { taskId: task.id, summary: '已整理交付材料。handout.html 按章节列出执行证据。' }),
        call('task.start', { taskId: task.id })], reply: '' }
    }).mockImplementationOnce(async prompt => {
      expect(prompt).toContain('已记录任务进展。')
      expect(prompt).toContain('「整理交付材料」已在进行中')
      return done('已记录进展，并将整理交付材料标记为进行中。')
    })
    const run = (await post('quote-file'))!
    expect(run.reply).toContain('已读取「handout.html」')
    expect(run.reply).toContain('按章节列出了执行证据')
    expect(JSON.stringify(run)).not.toContain('temporary-file-secret')
    await post('quote-file')
    const updated = projects.detail(id)
    expect(updated.tasks.find(item => item.id === task.id)).toMatchObject({ status: 'in-progress',
      progress: [{ author: 'Robin', source: 'dingtalk', summary: '已整理交付材料。handout.html 按章节列出执行证据。' }] })
    expect(updated.tickets).toEqual([])
    expect(h.runtime.projectEvents.list({ projectId: id }).filter(event => event.type === 'progress.recorded')).toHaveLength(1)
    expect(send.mock.calls.filter(([message]) => message.text === run.reply)).toHaveLength(1)
    expect(fetchFile).toHaveBeenCalledTimes(3)
    await post('outsider-file', { sender: 'outsider' })
    expect(fetchFile).toHaveBeenCalledTimes(3)
    const unsupported = await post('unsupported-file', { name: 'attachment.zip' })
    expect(unsupported?.reply).toContain('当前不支持这个文件格式')
    expect(fetchFile).toHaveBeenCalledTimes(3)
    const expired = await post('expired-file', { code: 'expired-code' })
    expect(expired?.reply).toContain('钉钉附件下载码无效或已过期')
    expect(fetchFile).toHaveBeenCalledTimes(4)
    const untrusted = await post('untrusted-file', { code: 'untrusted-code' })
    expect(untrusted?.reply).toContain('钉钉返回了不受支持的附件下载地址')
    expect(fetchFile).toHaveBeenCalledTimes(5)
    for (const extension of ['html', 'md', 'pdf']) {
      propose.mockImplementationOnce(async prompt => {
        expect(prompt).toContain('需要应用管理员处理当前部署问题')
        expect(prompt).not.toContain('private-egress-address')
        return done('正文尚未读取，任务进展没更新。')
      })
      const denied = await post(`ip-denied-${extension}`, { code: 'ip-denied', name: `workflow.${extension}` })
      expect(denied?.attachmentResults).toMatchObject([{ resolution: 'deployment' }])
      expect(denied?.reply).toContain('服务器出口 IP')
      expect(denied?.reply).not.toMatch(/private-egress-address|重新引用|上传导出/)
    }

    const execution = change({ kind: 'task', value: { title: '分析原始演示稿', executionMode: 'agent', ownerId: member.id } }).tasks.at(-1)!
    propose.mockResolvedValueOnce({ summary: '幻灯片摘要。' })
      .mockResolvedValueOnce({ calls: [call('execution.start', { taskId: execution.id })], reply: '' })
    const start = await post('start-with-file', { name: 'slides.pptx', code: 'slides-code', link: sourceLink })
    expect(start?.steps[0]?.error).toBeUndefined()
    const ticketId = projects.detail(id).tasks.find(item => item.id === execution.id)!.ticketId!
    expect(ticketId).toBeTruthy()
    const worker = `worker-${ticketId}`
    const assignment = h.relays(worker)[0] as { trigger: { attachments: { name: string; local_path: string }[] } }
    const first = assignment.trigger.attachments[0]!
    expect(first).toEqual({ name: 'slides.pptx', local_path: expect.stringMatching(/\.pptx$/) })
    expect(readFileSync(first.local_path)).toEqual(slides)
    expect(assignment.trigger).toMatchObject({ source_links: [sourceLink] })
    expect(start?.reply).toContain(materialReference(start!.id))

    propose.mockResolvedValueOnce({ summary: '幻灯片摘要。' })
      .mockResolvedValueOnce({ calls: [call('task.follow_up', { taskId: execution.id, text: '请打开原始附件并按页分析。' })], reply: '' })
    const follow = await post('follow-up-with-file', { name: 'slides.pptx', code: 'slides-code' })
    expect(follow?.steps[0]?.error).toBeUndefined()
    expect(h.relays(worker).at(-1)).toMatchObject({ text: '请打开原始附件并按页分析。', attachments: [first] })
    const downloads = fetchFile.mock.calls.length
    propose.mockImplementationOnce(async prompt => {
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
      expect(context.reference).toMatchObject({ quote: 'resolved', links: [sourceLink], message: { id: start!.id } })
      expect(context.attachments).toMatchObject([{ name: 'slides.pptx', availableToWorker: true }])
      return { calls: [call('task.follow_up', { taskId: execution.id, text: '继续用原件和原始链接核对。' })], reply: '' }
    })
    const fromSummary = await post('follow-up-with-summary', { summaryCard: start!.reply })
    expect(fromSummary?.steps[0]?.error).toBeUndefined()
    expect(h.relays(worker).at(-1)).toMatchObject({ text: '继续用原件和原始链接核对。', attachments: [first], source_links: [sourceLink] })
    expect(fetchFile).toHaveBeenCalledTimes(downloads)
    expect(JSON.stringify(h.relays(worker))).not.toMatch(/幻灯片摘要|slides-code/)
  } finally { callback.mockRestore(); ack.mockRestore() }
})

it('reads native, captioned and quoted DingTalk images through the shared attachment flow', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lck0AAAAASUVORK5CYII=', 'base64')
  const vision: NonNullable<ProjectPlanner['proposeWithImage']> = async (prompt, _schema, image) => {
    expect(prompt).toContain('实际可见')
    expect(prompt).not.toMatch(/image-code|signed-url/)
    expect(image.extension).toBe('.png')
    expect(image.bytes).toEqual(png)
    return { summary: '画面显示验收代号 LIME-37 和状态 READY。' }
  }
  const describe = vi.fn(vision)
  const { h, projects, id, member, assignee, change, propose } = await pilot(undefined, describe)
  change({ kind: 'add-member', memberId: assignee.id })
  const task = change({ kind: 'task', value: { title: '核对测试画面', ownerId: member.id } }).tasks.at(-1)!
  let bot: DingTalk
  const send = vi.fn((message: Parameters<DingTalk['send']>[0]) => bot.send(message))
  const kind = dingTalkKind(send)
  h.runtime.sources.register(kind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } } })
  let receive!: (frame: { headers: { messageId: string }; data: string }) => Promise<void>
  const callback = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, fn) {
    receive = fn as typeof receive; return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  const fetchMedia = vi.fn(async (url: URL | string, options?: RequestInit) => {
    if (String(url).endsWith('/accessToken')) return Response.json({ accessToken: 'auth-token' })
    if (String(url).endsWith('/messageFiles/download')) {
      const input = JSON.parse(String(options?.body))
      expect(input).toMatchObject({ robotCode: 'robot', downloadCode: expect.stringMatching(/^image-code-/) })
      return Response.json({ downloadUrl: `http://files.oss-cn-zhangjiakou.aliyuncs.com/${input.downloadCode.endsWith('bad') ? 'bad' : 'image'}?Signature=signed-url` })
    }
    expect(new URL(String(url)).protocol).toBe('https:')
    expect(options?.headers).toBeUndefined()
    expect(options?.redirect).toBe('error')
    return String(url).includes('/bad?') ? new Response('<html>Not an image</html>') : new Response(new Uint8Array(png))
  })
  const sendToDingTalk = vi.fn((_options: RequestInit | undefined) => Response.json({ errcode: 0 }))
  const http = async (url: URL | string, options?: RequestInit) => String(url).startsWith('https://oapi.dingtalk.com/robot/send?')
    ? sendToDingTalk(options) : fetchMedia(url, options)
  try {
    const agent = h.runtime.projectAgent!
    bot = new DingTalk(h.runtime.context(kind), { clientId: 'test', clientSecret: 'test' }, () => {}, http as typeof fetch,
      undefined, undefined, dingTalkProjectIntake(projects, h.runtime.projectPlanning, undefined, agent))
    agent.registerAttachmentReader('dingtalk', (message, attachment, signal) => bot.readProjectAttachment(message, attachment, signal))
    const post = async (msgId: string, content: Record<string, unknown>) => {
      await receive({ headers: { messageId: msgId }, data: JSON.stringify({ msgId, senderStaffId: 'member', conversationId: 'test-group',
        conversationType: '2', isInAtList: true, senderCorpId: 'test-corp', robotCode: 'robot',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?fixture', sessionWebhookExpiredTime: Date.now() + 60_000, ...content }) })
      await h.runtime.idle()
      return agent.runs(id).find(run => run.message.nativeMessageId === msgId)
    }
    const picture = { msgtype: 'picture', content: { downloadCode: 'image-code-native' } }
    const native = await post('native-image', picture)
    expect(native?.reply).toContain('已识别「图片 1.png」')
    expect(native?.reply).toContain('LIME-37')
    expect(propose).not.toHaveBeenCalled()
    expect(native?.attachmentResults?.[0]).toMatchObject({ kind: 'image', original: { file: expect.stringMatching(/\.png$/) } })
    await post('native-image', picture)
    expect(describe).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.filter(([message]) => message.text === native?.reply)).toHaveLength(1)

    propose.mockImplementationOnce(async prompt => {
      expect(prompt).toContain('请用图片记录任务进展')
      expect(prompt).toContain('LIME-37')
      expect(prompt).not.toMatch(/image-code|signed-url|iVBORw0KGgo/)
      return { calls: [call('progress.record', { taskId: task.id, summary: '截图显示验收代号 LIME-37，状态 READY。' }),
        call('conversation.mention', { memberId: assignee.id })], reply: '' }
    })
    propose.mockResolvedValueOnce(done('请核对截图里的测试画面。'))
    const caption = { msgtype: 'richText', content: JSON.stringify({ richText: [
      { text: '请用图片记录任务进展，并提醒李顺阳核对测试画面' }, { type: 'picture', pictureDownloadCode: 'image-code-rich' },
    ] }) }
    const rich = await post('rich-image', caption)
    expect(rich?.attachmentResults).toHaveLength(1)
    expect(projects.detail(id).tasks.at(-1)?.progress).toMatchObject([{ summary: '截图显示验收代号 LIME-37，状态 READY。' }])
    expect(projects.detail(id).tickets).toEqual([])
    await post('rich-image', caption)
    const mentioned = send.mock.calls.map(([message]) => message).filter(message => message.channel.address.mentionUserId)
    expect(mentioned).toMatchObject([{ text: rich?.reply, channel: { address: {
      conversationId: 'test-group', mentionUserId: 'assignee', mentionUserName: '李顺阳', explicitMentionMemberId: assignee.id,
    } } }])
    expect(mentioned[0]?.channel.address.triggerId).toBeUndefined()
    const nativePayloads = sendToDingTalk.mock.calls.map(([request]) => JSON.parse(String(request?.body))).filter(payload => payload.at)
    expect(nativePayloads).toMatchObject([{ msgtype: 'text', text: { content: expect.stringContaining('@assignee 请核对截图里的测试画面。') },
      at: { atUserIds: ['assignee'] } }])
    expect(projects.detail(id).tasks.at(-1)?.progress).toHaveLength(1)

    const quote = (msgId: string, content?: unknown) => ({ msgtype: 'text',
      text: { content: '请读引用的图', isReplyMsg: true, repliedMsg: { msgType: 'picture', msgId, content } } })
    const embedded = await post('quote-image', quote('not-cached', JSON.stringify({ downloadCode: 'image-code-quote' })))
    expect(embedded?.reply).toContain('LIME-37')
    const downloads = fetchMedia.mock.calls.length
    propose.mockResolvedValueOnce(done('下一步可以请李顺阳核对画面。'))
    const cached = await post('quote-cache', quote('native-image'))
    expect(cached?.reply).toContain('LIME-37')
    expect(cached?.reply).toContain('李顺阳')
    expect(fetchMedia).toHaveBeenCalledTimes(downloads)
    expect(send.mock.calls.find(([message]) => message.text === cached?.reply)?.[0].channel.address).not.toHaveProperty('mentionUserId')
    const missing = await post('quote-missing', quote('unknown-image'))
    expect(missing?.reply).toContain('没有可用的图片下载码')
    const wrongFormat = await post('bad-image', { msgtype: 'picture', content: { downloadCode: 'image-code-bad' } })
    expect(wrongFormat?.reply).toContain('图片内容无法识别')
    expect(describe).toHaveBeenCalledTimes(4)
    await post('outsider-image', { ...picture, senderStaffId: 'outsider' })
    await post('unaddressed-image', { ...picture, isInAtList: false })
    expect(describe).toHaveBeenCalledTimes(4)
    expect(fetchMedia.mock.calls.filter(([url]) => !String(url).endsWith('/accessToken'))).toHaveLength(8)
    expect(JSON.stringify(agent.runs(id))).not.toMatch(/image-code|signed-url/)
    expect(obsoleteExplicitProjectMention(h.runtime.store, mentioned[0]!)).toBe(false)
    change({ kind: 'remove-member', memberId: assignee.id })
    expect(obsoleteExplicitProjectMention(h.runtime.store, mentioned[0]!)).toBe(true)
    const unbound = projects.registerDingTalkSender('different-corp', 'different-staff-id', '其他企业成员').member
    change({ kind: 'add-member', memberId: unbound.id })
    propose.mockResolvedValueOnce({ calls: [call('progress.record', { taskId: task.id, summary: '已人工核对部分画面。' }),
      call('conversation.mention', { memberId: unbound.id })], reply: '' })
    propose.mockImplementationOnce(async prompt => {
      expect(prompt).toContain('尚未绑定本企业的钉钉账号，无法原生 @')
      return done('已记录进展。该成员尚未绑定本企业的钉钉账号。')
    })
    const withoutBinding = await post('unbound-mention', { msgtype: 'text', text: { content: '我已核对部分画面，请记录并通知其他企业成员。' } })
    expect(withoutBinding?.reply).toContain('尚未绑定')
    expect(projects.detail(id).tasks.at(-1)?.progress).toHaveLength(2)
    expect(send.mock.calls.find(([message]) => message.text === withoutBinding?.reply)?.[0].channel.address).not.toHaveProperty('mentionUserId')
  } finally { callback.mockRestore(); ack.mockRestore() }
})

it('keeps task start restricted to the owner and leaves progress available while dependencies are open', async () => {
  const { h, id, member, assignee, task, change, projects } = await pilot()
  change({ kind: 'project', value: { name: '2048 事件验收', status: 'active' } })
  change({ kind: 'add-member', memberId: assignee.id })
  const downstream = change({ kind: 'task', value: { title: '整理交付材料', ownerId: member.id,
    blockedBy: [task.id] } }).tasks.at(-1)!
  const tools = h.runtime.projectTools!
  const context = { projectId: id, actorId: member.id, messageId: 'waiting-work', operationId: 'waiting-work',
    channel: { source: 'dingtalk', thread: 'test-group', address: { conversationId: 'test-group' } } }
  expect(() => tools.execute('task.start', { taskId: downstream.id }, { ...context, actorId: assignee.id })).toThrow('只有任务负责人')
  expect(() => tools.execute('task.start', { taskId: downstream.id }, context)).toThrow('dependencies')
  expect(() => tools.execute('task.start', { taskId: task.id }, context)).toThrow('只有任务负责人')
  tools.execute('progress.record', { taskId: downstream.id, summary: '已列出交付清单' }, context)
  expect(projects.detail(id).tasks.at(-1)).toMatchObject({ status: 'todo', progress: [{ summary: '已列出交付清单' }] })
})

it('routes a bound Feishu project conversation and retrieves a retained message by native reference', async () => {
  const { h, projects, propose } = await pilot()
  const project = projects.create(ProjectInput.parse({ name: 'Feishu project', feishuChatId: CHAT }))
  const member = projects.saveMember(MemberInput.parse({
    name: 'Alice', accounts: [{ provider: 'feishu', scope: 'cli_bot', accountId: MEMBER }],
  }))
  projects.change(project.id, ProjectChange.parse({ revision: project.revision, change: { kind: 'add-member', memberId: member.id } }))
  const source = h.runtime.context(feishuKind)
  const route = (id: string, message: string, overrides: Record<string, unknown> = {}) =>
    source.receive(feishu(id, message, overrides))
  propose.mockImplementationOnce(async () => done('已登记测试窗口。'))
  expect(await route('history1', '发布窗口是下周三', { message_app_link: 'https://example.com/old-decision' })).toBe('filtered')
  await h.runtime.idle()
  const old = h.runtime.projectAgent!.runs(project.id)[0]!
  expect(old.message).toMatchObject({ nativeMessageId: 'om_history1', channel: { source: 'feishu' } })
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('"replyToNativeMessageId":"om_history1"')
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
    expect(context.reference).toEqual({ quote: 'resolved', links: [], message: { id: old.id, text: '发布窗口是下周三' } })
    return { calls: [call('conversation.history.search', { query: '发布窗口', after: '2026-09-09T00:00:01Z', before: '2026-09-09T00:00:02Z' }),
      call('conversation.history.read', { messageId: 'om_history1' })], reply: '' }
  }).mockImplementationOnce(async () => done('原文记录是下周三。'))
  await route('history2', '回顾一下原来是哪天？', { parent_id: 'om_history1', root_id: 'om_history1' })
  await h.runtime.idle()
  const recent = h.runtime.projectAgent!.runs(project.id).find(run => run.message.nativeMessageId === 'om_history2')!
  expect(recent.reply).toBe('原文记录是下周三。')
  expect(recent.steps[0]?.results[0]?.data).toEqual([expect.objectContaining({ messageId: old.id, author: 'Alice', url: 'https://example.com/old-decision' })])
  expect(recent.steps[0]?.results[1]?.data).toMatchObject({ text: '发布窗口是下周三', reply: '已登记测试窗口。' })
  expect(h.candidates()).toEqual([])
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: {
    ...settings.policy.sources, feishu: { allowed: [] },
  } } })
  expect(() => h.runtime.projectTools!.execute('conversation.history.read', { messageId: old.id },
    { ...recent.message, operationId: 'history-after-revocation' })).toThrow('无法读取当前会话的历史')
})

it('rejects membership spoofing, cross-project tools and stale group membership', async () => {
  const { h, id, member, projects, change, propose, task } = await pilot()
  expect(await h.api('POST', `projects/${id}/messages`, { text: 'change', actorId: 'forged' })).toMatchObject({ status: 400 })
  const other = projects.create(ProjectInput.parse({ name: 'Other project' }))
  const otherTask = projects.change(other.id, ProjectChange.parse({ revision: other.revision,
    change: { kind: 'task', value: { title: 'Private task' } } })).tasks[0]!
  expect(() => h.runtime.projectTools!.execute('task.update', { taskId: otherTask.id, changes: { title: 'Intrusion' } }, {
    projectId: id, actorId: member.id, messageId: 'bad', operationId: 'bad', channel: { source: 'dingtalk', thread: 'test-group', address: { conversationId: 'test-group' } },
  })).toThrow('does not belong')
  const kind = dingTalkKind(async () => {})
  h.runtime.sources.register(kind)
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise)
  h.runtime.projectAgent!.submit({ projectId: id, actorId: member.id, messageId: 'remove-member', text: '补充条件', quoted: '',
    channel: { source: 'dingtalk', thread: 'test-group', address: { conversationId: 'test-group' } } })
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  change({ kind: 'task', id: task.id, value: { title: task.title, ownerId: null } })
  change({ kind: 'remove-member', memberId: member.id })
  pending.resolve({ calls: [call('task.update', { taskId: task.id, changes: { acceptance: 'unauthorized' } })], reply: '' })
  await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.acceptance).not.toBe('unauthorized')
  expect(h.runtime.projectAgent!.runs(id)[0]?.status).toBe('failed')
})

it('ships a matching default JSON for the message event and its configuration documentation', () => {
  const defaults = JSON.parse(readFileSync(new URL('../config/events/dingtalk.defaults.json', import.meta.url), 'utf8'))
  expect(defaults.sources.dingtalk.on['project.message.received']).toEqual({ enabled: true, description: projectMessageReceived.description })
  expect(readFileSync(new URL(`../${projectMessageReceived.documentation}`, import.meta.url), 'utf8')).toContain('project.message.received')
})

it('queues a DingTalk meeting for its authorized sender, requires current mentions and does not duplicate a callback', async () => {
  const create = vi.fn<CalendarExecutor['create']>().mockResolvedValue({ state: 'verified', eventId: 'event-id', roomCode: '123 456 789' })
  const receipt = vi.fn<CalendarExecutor['receipt']>().mockResolvedValue({ state: 'uncertain' })
  const manage = vi.fn<NonNullable<CalendarExecutor['manage']>>().mockImplementation(async (_id, request) => ({
    state: 'confirmed', eventId: request.action.eventId,
    snapshot: request.action.kind === 'cancel' ? { title: '', status: 'cancelled' } :
      { title: '调整后会议', roomCode: '123 456 789' },
  }))
  const { h, id, projects, assignee, change, propose } = await pilot(undefined, undefined,
    { corpId: 'test-corp', organizers: ['member'], create, manage, receipt })
  change({ kind: 'add-member', memberId: assignee.id })
  const send = vi.fn()
  const kind = dingTalkKind(async message => { send(message) })
  h.runtime.sources.register(kind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } } })
  let receive!: (frame: { headers: { messageId: string }; data: string }) => Promise<void>
  const callback = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, fn) {
    receive = fn as typeof receive; return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  try {
    const bot = new DingTalk(h.runtime.context(kind), { clientId: 'test', clientSecret: 'test' }, () => {}, fetch,
      undefined, undefined, dingTalkProjectIntake(projects, h.runtime.projectPlanning, undefined, h.runtime.projectAgent))
    const post = async (msgId: string, senderStaffId: string, includeAttendee = true) => {
      await receive({ headers: { messageId: msgId }, data: JSON.stringify({ msgId, senderStaffId, conversationId: 'test-group',
        conversationType: '2', isInAtList: true, senderCorpId: 'test-corp', robotCode: 'robot', chatbotUserId: 'bot', msgtype: 'text',
        atUsers: [{ dingtalkId: 'bot' }, ...(includeAttendee ? [{ staffId: 'assignee' }] : [])],
        text: { content: '请创建测试会议，邀请已 @ 的项目成员。' },
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?fixture', sessionWebhookExpiredTime: Date.now() + 60_000 }) })
      await h.runtime.idle()
    }
    const event = { title: '测试会议', start: new Date(Date.now() + 3_600_000).toISOString(),
      end: new Date(Date.now() + 7_200_000).toISOString(), inviteMemberIds: [assignee.id] }
    const action = { calls: [call('calendar.create_event', event)], reply: '会议未创建。' }
    propose.mockImplementationOnce(async prompt => {
      expect(prompt).toContain('calendar.create_event')
      return { ...action, calls: [...action.calls, ...action.calls] }
    })
    await post('calendar-ok', 'member')
    await post('calendar-ok', 'member')
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.any(String),
      expect.objectContaining({ projectId: id, organizer: 'member', attendees: ['assignee'], event }), expect.any(AbortSignal))
    expect(send.mock.calls.filter(([message]) => message.text.includes('123 456 789'))).toHaveLength(1)

    propose.mockResolvedValueOnce(action).mockResolvedValueOnce(done())
    await post('calendar-without-mention', 'member', false)
    propose.mockResolvedValueOnce(action).mockResolvedValueOnce(done())
    await post('calendar-not-authorized', 'assignee')
    expect(create).toHaveBeenCalledTimes(1)
    const agent = h.runtime.projectAgent!
    expect(agent.runs(id).find(run => run.message.nativeMessageId === 'calendar-without-mention')?.steps[0]?.error).toContain('明确 @')
    expect(agent.runs(id).find(run => run.message.nativeMessageId === 'calendar-not-authorized')?.steps[0]?.error).toContain('已获授权')
    const calendarCall = (name: string, args: object, accepted = true) => {
      propose.mockResolvedValueOnce({ calls: [call(name, args)], reply: '会议未创建。' })
      if (!accepted) propose.mockResolvedValueOnce(done())
    }
    calendarCall('calendar.update_event', { eventId: 'event-id', title: '调整后会议' })
    await post('calendar-update', 'member')
    calendarCall('calendar.add_attendees', { eventId: 'event-id', inviteMemberIds: [assignee.id] })
    await post('calendar-invite', 'member')
    calendarCall('calendar.get_event', { eventId: 'event-id' })
    await post('calendar-read', 'member')
    calendarCall('calendar.cancel_event', { eventId: 'some-other-event' }, false)
    await post('calendar-wrong-target', 'member')
    calendarCall('calendar.cancel_event', { eventId: 'event-id' })
    await post('calendar-cancel', 'member')
    await post('calendar-cancel', 'member')
    calendarCall('calendar.add_attendees', { eventId: 'event-id', inviteMemberIds: [assignee.id] }, false)
    await post('calendar-invite-after-cancel', 'member')
    expect(manage.mock.calls.map(([, request]) => request.action.kind)).toEqual(['update', 'invite', 'read', 'cancel'])
    expect(manage.mock.calls[1]?.[1].attendees).toEqual(['assignee'])
    for (const text of ['已修改并核验日程', '已添加并核验参会人', '已查询日程', '已取消并核验日程'])
      expect(send.mock.calls.some(([message]) => message.text.includes(text))).toBe(true)

    // The executor can settle immediately. Only the server-authored pending and verified messages may arrive.
    for (const [nativeId, pending, final] of [
      ['calendar-ok', '正在创建钉钉日程', '已创建并核验钉钉日程'],
      ['calendar-cancel', '正在取消钉钉日程', '已取消并核验日程'],
    ] as const) {
      const run = agent.runs(id).find(item => item.message.nativeMessageId === nativeId)!
      const delivered = send.mock.calls.map(([message]) => message)
        .filter(message => message.channel.address.triggerId === run.message.messageId)
      expect(delivered).toMatchObject([
        { kind: 'acknowledgement', text: '已收到，正在结合项目现状处理。' },
        { kind: 'acknowledgement', text: expect.stringContaining(pending) },
        { kind: 'notice', text: expect.stringContaining(final), origin: { runId: run.id } },
      ])
    }

    // Recover an attempt interrupted after its write was started. It must only read the existing receipt.
    const attemptKey = h.runtime.store.keys(KV.projects.calendarAttempt)
      .find(key => !!h.runtime.store.get(key)?.request.event)
    const saved = h.runtime.store.get(attemptKey!)!
    h.runtime.store.set(KV.projects.calendarAttempt('interrupted'), { request: saved.request, state: 'started' })
    h.runtime.effects.enqueue('project-calendar', 'interrupted', {})
    await h.runtime.idle()
    expect(receipt).toHaveBeenCalledWith('interrupted', expect.objectContaining({ organizer: 'member' }))
    expect(h.runtime.store.get(KV.projects.calendarAttempt('interrupted'))?.receipt).toEqual({ state: 'uncertain' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(bot).toBeDefined()
  } finally { callback.mockRestore(); ack.mockRestore() }
})

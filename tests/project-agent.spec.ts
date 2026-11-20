import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DWClient } from 'dingtalk-stream'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import type { ProjectAgentRun } from '../src/app/project-agent.ts'
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
async function pilot(knowledgeDir?: string) {
  const propose = vi.fn(async (_prompt: string, _schema: object, _signal: AbortSignal): Promise<unknown> => done())
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Test Agent', propose }, knowledgeDir)
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
  const { h, projects, id, assignee, task, propose, say } = await pilot()
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('请你帮忙梳理 验收通过条件并分派给 李顺阳')
    expect(prompt).toContain('整理开发测试用例')
    expect(prompt).toContain(assignee.id)
    expect(prompt).toContain('task.create')
    return { calls: [call('member.add', { memberId: assignee.id }), call('task.create', { title: '整理开发测试用例',
      description: '整理普通合并、连续相同数字、无效移动、结束与重开的用例', acceptance: '每条列明初始棋盘、操作、预期棋盘和计分变化',
      ownerId: assignee.id, executionMode: 'agent', blockedBy: [task.id] })], reply: '' }
  }).mockImplementationOnce(async prompt => {
    expect(prompt).toContain('已创建「整理开发测试用例」')
    return done('已补充测试用例的验收条件，由李顺阳验收。')
  })
  const run = await say('screenshot', '请你帮忙梳理 验收通过条件并分派给 李顺阳',
    '整理开发测试用例由 Agent 执行、李顺阳验收。需要覆盖哪些内容，以什么条件验收？')
  expect(run.status).toBe('completed')
  expect(projects.detail(id)).toMatchObject({ status: 'planning', autoAdvance: false, tickets: [], tasks: [task,
    { title: '整理开发测试用例', status: 'todo', ownerId: assignee.id, executionMode: 'agent', blockedBy: [task.id] }] })
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
  propose.mockResolvedValueOnce({ calls: [call('project.update', { status: 'active' }), call('task.start', { taskId: task.id })], reply: '' })
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
  propose.mockResolvedValueOnce({ calls: [call('project.update', { status: 'active' }), call('task.start', { taskId: downstream.id })], reply: '' })
  const run = await say('blocked-dispatch', '先开始第二项')
  expect(run.steps[0]?.error).toBeTruthy()
  expect(projects.detail(id)).toMatchObject({ status: 'planning', tickets: [] })
})

it('tells the Agent whether a reviewer is designated or a real delivery is awaiting review', async () => {
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
    expect(context.tasks[1]).toMatchObject({ status: 'in-progress', deliveryReview: { status: 'not-requested', reviewerId: assignee.id } })
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
    expect(context.tasks[1]).toMatchObject({ status: 'in-review', deliveryReview: { status: 'pending', reviewId: review.id, reviewerId: assignee.id } })
    expect(context.tasks[2]).toMatchObject({ status: 'todo', blockedBy: [upstream.id] })
    return done('交付已提交，等李顺阳验收。')
  })
  expect(await say('wait-for-review', '人工试用现在还在等什么？')).toMatchObject({ status: 'completed', steps: [], reply: '交付已提交，等李顺阳验收。' })
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
  } finally { callback.mockRestore(); ack.mockRestore() }
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

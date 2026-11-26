import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DWClient } from 'dingtalk-stream'
import { afterEach, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { ProjectEvents } from '../src/app/project-events.ts'
import { ProjectTracking } from '../src/app/project-tracking.ts'
import { ProjectChange, ProjectInput, Projects, type ProjectDetail } from '../src/app/projects.ts'
import { Store } from '../src/app/store.ts'
import { inWorkingHours, TrackingSchedule, trackingSlots } from '../src/app/tracking-schedule.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { DingTalk, dingTalkKind, dingTalkProjectIntake, dingTalkRoute } from '../src/sources/dingtalk.ts'
import { deferred } from './fixtures/async.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const group = 'fixture-group'
const corpId = 'fixture-corporation'
const question = '键盘和触屏用例、试用设备准备好了吗？还缺哪项交付？'
const ready = '已整理五项用例，确认 Chrome 和 iPhone Safari；跑用例还缺试玩链接。'
const schedule = { timeZone: 'Asia/Shanghai', times: ['10:00', '16:00'] }
const clock = (local: string) => new Date(`2026-11-19T${local}:00+08:00`)
const done = (reply = '已登记，请查看推进记录。') => ({ calls: [], reply })
const tool = (tool: string, args: object) => ({ calls: [{ tool, arguments: JSON.stringify(args) }], reply: '' })
const data = (prompt: string) => JSON.parse(prompt.split('\n\n').at(-1)!)
const suggest = (taskId: string, recipientId: string, ...evidenceRefs: string[]) => ({ suggestions: [{ taskId, recipientId, question,
  reason: '试玩版本待验收，测试人员现在可以确认设备和用例。', evidenceRefs }] })
let host: Host | undefined
afterEach(async () => {
  await host?.stop()
  host = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function pilot(start: string, configure = true) {
  const propose = vi.fn(async (_prompt: string): Promise<unknown> => done())
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Tracking Agent', propose })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(clock(start))
  const { runtime } = h
  const projects = new Projects(runtime.store)
  const project = projects.create(ProjectInput.parse({ name: '2048', status: 'active', autoAdvance: false, dingTalkGroup: group,
    ...(configure && { tracking: schedule }) }))
  const { id } = project
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  const alice = projects.addDingTalkSender(id, corpId, 'alice', '甲')
  const carol = projects.addDingTalkSender(id, corpId, 'carol', '丙')
  expect(alice.added && carol.added).toBe(true)
  const members = projects.detail(id).members
  const owner = (name: string) => members.find(member => member.name === name)!.id
  const upstream = change({ kind: 'task', value: { title: 'B 试玩版本', ownerId: owner('甲'), executionMode: 'manual' } }).tasks[0]!
  const task = change({ kind: 'task', value: { title: 'C 实机试玩', ownerId: owner('丙'), blockedBy: [upstream.id],
    executionMode: 'manual', acceptance: '键盘、触屏与重开', dueDate: '2026-11-20' } }).tasks[1]!
  const log = vi.fn()
  const http = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/accessToken')) return Response.json({ accessToken: 'fixture-token', expireIn: 7200 })
    if (parsed.hostname === 'oapi.dingtalk.com' && parsed.pathname === '/robot/send') return Response.json({ errcode: 0 })
    if (parsed.pathname === '/v1.0/robot/groupMessages/send') return Response.json({ processQueryKey: 'fixture-accepted' })
    throw new Error('Unexpected Mock DingTalk HTTP route')
  })
  let bot!: DingTalk
  const kind = dingTalkKind(message => bot.send(message))
  runtime.sources.register(kind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } } })
  runtime.store.set(dingTalkRoute(group), { webhook: 'https://oapi.dingtalk.com/robot/send?fixture', expires: 0, robotCode: 'fixture-robot',
    conversationId: group, corpId })
  let receive!: (frame: { headers: { messageId: string }; data: string }) => Promise<void>
  vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, callback) {
    receive = callback as typeof receive
    return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  const connect = vi.spyOn(DWClient.prototype, 'connect').mockImplementation(async () => {})
  bot = new DingTalk(runtime.context(kind), { clientId: 'fixture-id', clientSecret: 'fixture-secret' }, log, http as typeof fetch,
    undefined, undefined, dingTalkProjectIntake(projects, runtime.projectPlanning, undefined, runtime.projectAgent))
  const say = (messageId: string, text: string, senderStaffId = 'alice', conversationId = group, quote?: string) => receive({
    headers: { messageId }, data: JSON.stringify({ msgId: messageId, conversationId, conversationType: '2', isInAtList: true,
      senderStaffId, senderCorpId: corpId, chatbotUserId: 'fixture-bot', robotCode: 'fixture-robot', msgtype: 'text',
      text: { content: text, ...(quote && { isReplyMsg: true, repliedMsg: { senderId: 'fixture-bot', content: quote } }) },
      sessionWebhook: 'https://oapi.dingtalk.com/robot/send?fixture', sessionWebhookExpiredTime: Date.now() + 60_000 }),
  })
  const send = () => http.mock.calls.flatMap(([url, init]) => {
    if (String(url).endsWith('/accessToken')) return []
    const payload = JSON.parse(String(init?.body))
    const content = payload.text?.content ?? payload.markdown?.text ?? JSON.parse(payload.msgParam).content
    return typeof content === 'string' && content.includes('进展跟进\n\n') ? [{ content, mentions: payload.at?.atUserIds ?? payload.atUserIds, url: String(url) }] : []
  })
  const advance = async (time: string) => { await vi.advanceTimersByTimeAsync(clock(time).getTime() - Date.now()); await runtime.idle() }
  const detail = () => projects.detail(id)
  const reviewResponse = await h.api('POST', `projects/${id}/tasks/${upstream.id}/deliveries`, { messageId: 'b-delivery', summary: 'B 提供了候选试玩版。' })
  expect(reviewResponse.status).toBe(200)
  await runtime.idle()
  propose.mockClear()
  const review = detail().tasks[0]!.reviews!.at(-1)!
  const events = (type: string) => runtime.projectEvents.list({ projectId: id, limit: 100 }).filter(event => event.type === type)
  const progressPath = `projects/${id}/tasks/${task.id}/progress`
  const assertions = () => {
    const { tasks, ...project } = detail()
    expect(project).toMatchObject({ autoAdvance: false, tickets: [] })
    expect(tasks.slice(0, 2)).toMatchObject([{ status: 'in-review' }, { status: 'todo', blockedBy: [upstream.id] }])
    expect(log).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  }
  return { h, runtime, projects, id, change, task, upstream, owner, review, propose, say, send, advance, detail, events, progressPath, assertions, ack, http }
}

it('follows up through the Mock DingTalk callback, records the quoted reply and stays quiet at the next scheduled scan', async () => {
  const { runtime, h, id, task, upstream, review, owner, propose, say, send, advance, detail, events, assertions, ack } = await pilot('14:00')
  const focus = '看看试玩链接就绪前还有什么能先准备'
  propose.mockImplementation(async prompt => {
    const context = data(prompt)
    if (context.candidates) {
      expect(context.candidates.find((candidate: { taskId: string }) => candidate.taskId === task.id).evidence[`review:${review.id}`])
        .toMatchObject({ taskId: upstream.id, status: 'pending' })
      if (context.focus === focus) {
        expect(context.candidates).toHaveLength(1)
        return suggest(task.id, owner('丙'), `review:${review.id}`, `task:${task.id}`)
      }
      expect(prompt).toContain('五项用例')
      expect(context.candidates).toContainEqual(expect.objectContaining({ taskId: task.id, coolingDown: true,
        lastReminder: expect.objectContaining({ status: 'sent' }) }))
      return { suggestions: [] }
    }
    if (context.previousSteps.length) return done()
    if (context.message.text.includes('五项用例')) {
      expect(context.message.quoted).toContain(task.title)
      return tool('progress.record', { taskId: task.id, summary: ready, blocker: '缺试玩链接' })
    }
    return tool('tracking.request', { taskId: task.id, focus })
  })
  await say('ping', 'C 那边麻烦帮我问一声。')
  await say('ping', 'C 那边麻烦帮我问一声。')
  await runtime.idle()
  expect(events('tracking.ping.requested')).toHaveLength(1)
  expect(send()).toEqual([{ mentions: ['carol'], content: expect.stringContaining(question), url: expect.stringContaining('oapi.dingtalk.com') }])
  const quote = send()[0]!.content
  expect(quote).toContain(task.id.slice(0, 8))
  await say('reply', ready, 'carol', group, quote)
  await say('reply', ready, 'carol', group, quote)
  await runtime.idle()
  expect(ack).toHaveBeenCalledTimes(4)
  expect(events('project.message.received')).toHaveLength(2)
  expect(detail().tasks[1]?.progress).toEqual([expect.objectContaining({ summary: ready, blocker: '缺试玩链接', actorId: owner('丙'),
    author: '丙', source: 'dingtalk', original: ready, at: clock('14:00').toISOString() })])
  const history = await h.api('GET', `projects/${id}/history`)
  expect(history.body).toMatchObject({ notifications: expect.arrayContaining([expect.objectContaining({ status: 'sent',
    origin: { projectId: id, eventId: events('tracking.ping.requested')[0]!.id, taskId: task.id } })]) })
  expect(history.body).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ delivery: { status: 'sent', nativeMention: true } })]) })
  await advance('16:00')
  expect(events('tracking.check.resolved').map(event => event.data)).toMatchObject([{ state: 'quiet' }, { state: 'queued' }])
  expect(events('progress.recorded')).toHaveLength(1)
  expect(send()).toHaveLength(1)
  assertions()
})

it('uses a configurable project clock with zero inbound messages and reads subsequent web progress without dispatching', async () => {
  const { h, runtime, id, task, upstream, review, change, owner, propose, send, advance, detail, events, progressPath, assertions } = await pilot('09:55', false)
  const response = await h.api('POST', `projects/${id}/changes`, { revision: detail().revision,
    change: { kind: 'project', value: { name: '2048', tracking: { ...schedule, times: ['10:01', '16:00'], workHours: { start: '09:00', end: '17:00' } } } } })
  expect(response).toMatchObject({ status: 200, body: { tracking: { timeZone: 'Asia/Shanghai', times: ['10:01', '16:00'] } } })
  const other = new Projects(runtime.store).create(ProjectInput.parse({ name: 'Other project' }))
  propose.mockImplementation(async prompt => {
    const context = data(prompt)
    expect(context.candidates.map((candidate: { taskId: string }) => candidate.taskId)).toEqual([upstream.id, task.id])
    const candidate = context.candidates[1]
    expect(candidate.evidence[`review:${review.id}`]).toMatchObject({ status: 'pending' })
    expect(candidate.evidence[`task:${task.id}`]).toMatchObject({ status: 'todo', dueDate: '2026-11-20', dependencies: [upstream.id] })
    if (!candidate.lastReminder) return suggest(task.id, owner('丙'), `review:${review.id}`)
    expect(prompt).toContain('五项用例')
    // A repeated recommendation from the provider must still be suppressed by the service.
    return suggest(task.id, owner('丙'), `task:${task.id}`)
  })
  await advance('10:00')
  expect(events('tracking.check.due')).toEqual([])
  await advance('10:01')
  runtime.projectTracking.recover(); runtime.projectTracking.recover(); await runtime.idle()
  expect(events('tracking.check.due')).toHaveLength(1)
  expect(send()).toEqual([{ mentions: undefined, content: expect.stringContaining(`请 丙 查看\n\n「${task.title}」`),
    url: 'https://api.dingtalk.com/v1.0/robot/groupMessages/send' }])
  await advance('10:20')
  const recorded = await h.api('POST', progressPath, { messageId: 'web-progress', summary: ready, links: ['https://example.test/cases'] })
  expect(recorded).toMatchObject({ status: 200, body: { source: 'request', actorId: null, summary: ready } })
  expect(await h.api('POST', progressPath, { messageId: 'web-progress', summary: ready })).toEqual(recorded)
  await advance('16:00')
  expect(send()).toHaveLength(1)
  expect(detail().tasks[1]?.progress).toHaveLength(1)
  expect(events('tracking.check.resolved').map(event => event.data)).toMatchObject([{ state: 'skipped', reason: expect.stringContaining('冷却期') }, { state: 'queued' }])
  expect(events('project.message.received')).toEqual([])
  expect(runtime.projectEvents.list({ projectId: other.id }).some(event => event.type === 'tracking.check.due')).toBe(false)
  change({ kind: 'project', value: { name: '2048', tracking: null } })
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
  await runtime.idle()
  expect(events('tracking.check.due')).toHaveLength(2)
  assertions()
})

it('revalidates author and project scope and stores corrections on an unassigned task', async () => {
  const { h, runtime, projects, id, change, owner, say, propose, events, detail, assertions } = await pilot('12:00', false)
  const task = change({ kind: 'task', value: { title: 'D 兼容性调查' } }).tasks.at(-1)!
  const path = `projects/${id}/tasks/${task.id}/progress`
  await say('outsider', '帮忙问问 D。', 'outsider')
  await say('wrong-group', '帮忙问问 D。', 'alice', 'unrelated-group')
  await runtime.idle()
  expect(events('tracking.ping.requested')).toEqual([])
  expect(propose).not.toHaveBeenCalled()
  const accepted = await h.api('POST', path, { messageId: 'first', summary: '已用两个浏览器测试' })
  expect(accepted.status).toBe(200)
  const corrects = accepted.body.id as string
  expect(() => projects.recordProgress(id, task.id, { summary: '错误的更正', corrects },
    { source: 'dingtalk', messageId: 'someone-else', actorId: owner('甲') })).toThrow(/original author/)
  expect(await h.api('POST', path, { messageId: 'correction', summary: '已用三个浏览器测试', corrects })).toMatchObject({ status: 200 })
  expect(await h.api('POST', path, { messageId: 'bad-link', summary: 'Test', links: ['javascript:alert(1)'] })).toMatchObject({ status: 400 })
  expect(detail().tasks.find(item => item.id === task.id)).toMatchObject({ ownerId: null, status: 'todo', progress: [{ id: corrects, summary: '已用两个浏览器测试' },
    { corrects, summary: '已用三个浏览器测试' }] })
  assertions()
})

it('can follow the missing upstream delivery when the downstream preparation is already complete', async () => {
  const { h, task, upstream, review, owner, propose, send, advance, progressPath, events, assertions } = await pilot('09:50')
  await h.api('POST', progressPath, { messageId: 'prepared', summary: ready })
  propose.mockImplementation(async prompt => {
    const context = data(prompt)
    expect(prompt).toContain('跑用例还缺试玩链接')
    expect(context.candidates[1]).toMatchObject({ taskId: task.id, reachable: true })
    return { suggestions: [{ taskId: upstream.id, recipientId: owner('甲'), question: '试玩链接可以发给试用负责人了吗？',
      reason: '试玩准备齐全，仍等上游的可运行版本。', evidenceRefs: [`review:${review.id}`] }] }
  })
  await advance('10:00')
  expect(send()).toEqual([{ mentions: undefined, content: expect.stringContaining('试玩链接可以发给试用负责人了吗？'), url: expect.any(String) }])
  expect(events('tracking.check.resolved')[0]).toMatchObject({ taskId: upstream.id, data: { state: 'queued' } })
  assertions()
})

it('checks the current blocker with the member named by the Worker and rejects the future reviewer', async () => {
  const { h, runtime, id, change, detail, owner, propose, send, events, advance } = await pilot('09:50')
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  const task = change({ kind: 'task', value: { title: '候选版交付', executionMode: 'agent', ownerId: owner('甲') } }).tasks.at(-1)!
  expect((await h.api('POST', `projects/${id}/tasks/${task.id}/run`, { revision: detail().revision })).status).toBe(200)
  await runtime.idle()
  const ticketId = detail().tasks.find(item => item.id === task.id)!.ticketId!
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'blocked', summary: '已通过规则测试，真机证据待补',
    human_action: '请丙在真机上检查触屏并回传截图。' })
  await runtime.idle()
  const ref = `ticket:${ticketId}`
  propose.mockResolvedValueOnce(suggest(task.id, owner('甲'), ref))
  const path = `projects/${id}/tasks/${task.id}/tracking`
  await h.api('POST', path, { messageId: 'future-reviewer' })
  await runtime.idle()
  expect(send()).toEqual([])
  expect(events('tracking.check.resolved')[0]?.data).toMatchObject({ state: 'skipped', reason: expect.stringContaining('收件人') })

  propose.mockImplementationOnce(async prompt => {
    const candidate = data(prompt).candidates.find((item: { taskId: string }) => item.taskId === task.id)
    expect(candidate).toMatchObject({ questionRef: ref, recipients: [{ id: owner('丙'), name: '丙' }],
      evidence: { [ref]: { question: '请丙在真机上检查触屏并回传截图。' },
        [`task:${task.id}`]: { deliveryReview: { status: 'not-requested', reviewerId: null } } } })
    return suggest(task.id, owner('丙'), ref)
  })
  await advance('10:00')
  expect(send()).toEqual([{ mentions: undefined, content: expect.stringContaining(question), url: expect.any(String) }])
  expect(detail().tasks.find(item => item.id === task.id)).toMatchObject({ status: 'in-progress', ownerId: owner('甲') })
})

it('rejects hallucinated references and drops a stale reminder that was waiting for Outbox retry', async () => {
  const { h, runtime, id, task, owner, propose, send, http, events, progressPath, assertions } = await pilot('10:10', false)
  const path = `projects/${id}/tasks/${task.id}/tracking`
  propose.mockResolvedValueOnce(suggest(task.id, owner('丙'), 'invented'))
  await h.api('POST', path, { messageId: 'bad-reference' }); await runtime.idle()
  expect(events('tracking.check.resolved')[0]?.data).toMatchObject({ state: 'skipped', reason: expect.stringContaining('证据范围') })
  expect(send()).toHaveLength(0)

  // New evidence lands while a valid Agent proposal is still being generated.
  const ai = deferred<unknown>()
  propose.mockImplementationOnce(() => ai.promise)
  await h.api('POST', path, { messageId: 'in-flight' })
  await vi.advanceTimersByTimeAsync(0)
  try {
    expect(propose).toHaveBeenCalledTimes(2)
    await h.api('POST', progressPath, { messageId: 'during-analysis', summary: '提前确认 Chrome 版本' })
  } finally { ai.resolve(suggest(task.id, owner('丙'), `task:${task.id}`)) }
  await runtime.idle()
  expect(events('tracking.check.resolved')[0]?.data).toMatchObject({ state: 'skipped', reason: expect.stringContaining('已经变更') })

  // A transport error leaves an auditable pending receipt. Retry must observe subsequent evidence.
  propose.mockResolvedValueOnce(suggest(task.id, owner('丙'), `task:${task.id}`))
  http.mockRejectedValueOnce(new Error('fixture transport failure'))
  await h.api('POST', path, { messageId: 'retry' }); await runtime.idle()
  const outcome = events('tracking.check.resolved')[0]?.data as { receiptId: string }
  expect(runtime.store.receipts.get(outcome.receiptId)?.status).toBe('pending')
  expect(runtime.store.receipts.failure(outcome.receiptId)).toContain('fixture transport failure')
  const attempts = http.mock.calls.length
  await h.api('POST', progressPath, { messageId: 'before-retry', summary: ready })
  await vi.advanceTimersByTimeAsync(5_010)
  await runtime.pump(); await runtime.idle()
  expect(runtime.store.receipts.get(outcome.receiptId)).toMatchObject({ status: 'dropped', dropped: { reason: 'obsolete' } })
  expect(http).toHaveBeenCalledTimes(attempts)
  assertions()
})

it('recovers an offline schedule once from the same SQLite state and keeps its original cadence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tracking-restart-'))
  const filename = join(directory, 'state.sqlite')
  let now = clock('09:55').getTime()
  let close: (() => Promise<void>) | undefined
  try {
    const run = () => {
      const store = new Store(filename), lifetime = new AbortController()
      const effects = new Effects(store, new HealthBoard(), () => now)
      const events = new ProjectEvents(store, effects)
      const propose = vi.fn(async () => ({ suggestions: [] }))
      const tracking = new ProjectTracking({ store, effects, events, lifetime: lifetime.signal, now: () => now,
        planner: () => ({ name: 'test', propose }), recipient: () => undefined, channelAllowed: () => false,
        notify: () => { throw new Error('No external transport in recovery test') }, runnable: () => true })
      close = async () => { lifetime.abort(); await effects.drain(); store.close() }
      tracking.recover(); events.recover(); effects.start()
      return { store, tracking, events, effects, propose }
    }
    const first = run()
    const projects = new Projects(first.store)
    const { id } = projects.create(ProjectInput.parse({ name: 'Recovery', tracking: schedule }))
    const populated: ProjectDetail = projects.change(id, ProjectChange.parse({ revision: 0, change: { kind: 'task', value: { title: 'Waiting' } } }))
    expect(populated.tasks).toHaveLength(1)
    await close!()
    now = clock('16:30').getTime()
    const second = run()
    second.tracking.recover()
    await second.effects.idle()
    const due = second.events.list({ projectId: id }).filter(event => event.type === 'tracking.check.due')
    expect(due.map(event => event.occurredAt)).toEqual([clock('16:00').toISOString()])
    expect(second.propose).toHaveBeenCalledOnce()
    expect(second.store.get(KV.projects.trackingClock(id))?.nextAt).toBe(Date.parse('2026-11-20T02:00:00Z'))
  } finally {
    await close?.()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('uses the configured time zone across a weekend DST change and validates local work hours', () => {
  const local = TrackingSchedule.parse({ timeZone: 'America/New_York', times: ['10:00', '10:00'] })
  expect(local.times).toEqual(['10:00'])
  const sunday = Date.parse('2026-11-01T15:00:00Z')
  expect(trackingSlots(local, sunday)).toEqual({ latest: Date.parse('2026-10-30T14:00:00Z'), next: Date.parse('2026-11-02T15:00:00Z') })
  expect(inWorkingHours(local, sunday)).toBe(false)
  expect(TrackingSchedule.safeParse({ timeZone: 'UTC', times: ['23:00'] }).success).toBe(false)
  expect(TrackingSchedule.safeParse({ timeZone: 'invalid/timezone', times: ['10:00'] }).success).toBe(false)
})

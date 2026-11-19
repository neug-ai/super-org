import { afterEach, expect, it, vi } from 'vitest'
import { DWClient } from 'dingtalk-stream'
import { Projects } from '../src/app/projects.ts'
import { startRuntime } from './fixtures/host.ts'
import { dingTalkKind, dingTalkProjectIntake, DingTalk } from '../src/sources/dingtalk.ts'

let h: Awaited<ReturnType<typeof startRuntime>> | undefined
afterEach(async () => { await h?.stop(); h = undefined; vi.restoreAllMocks() })

it('routes local requests like mentions and requires confirmation and a terminal reply on the default group card', async () => {
  let robot: DingTalk
  h = await startRuntime(undefined, 'test-group', trigger => robot.received(trigger),
    (...args) => robot.bindWorkerDelivery(...args))
  const group = dingTalkKind(message => robot.send(message))
  h.runtime.sources.register(group)
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources,
    request: { allowed: [{ id: 'local' }] } } }, h.runtime.store.blockRevision('policy'), 'panel')
  const http = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('/oauth2/')
    ? { accessToken: 'token', expireIn: 7200 } : {})))
  robot = new DingTalk(h.runtime.context(group), { clientId: 'robot', clientSecret: 'test' }, () => {}, http, 'card-template')
  const response = await h.api('POST', 'requests', { prompt: 'Check whether CI needs attention' })
  expect(response.status).toBe(200)
  const id = String(response.body.trigger_id)
  await h.runtime.idle()
  expect(h.candidates()).toContain(id)
  expect(h.runtime.store.triggers.get(id)).toMatchObject({ source: 'request', text: 'Check whether CI needs attention',
    channel: { source: 'dingtalk', address: { conversationId: 'test-group' } } })
  const listed = await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'list' })
  expect(listed.cards).toEqual([expect.objectContaining({ trigger_id: id })])
  const card = (listed.cards as { card_id: string }[])[0]!.card_id
  await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'acknowledge', card_id: card, text: 'Checking CI.' })
  await h.route({ kind: 'ignore', trigger_id: id, reason: 'No action is needed.' })
  expect((await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'list' })).cards).toHaveLength(1)
  await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'reply', card_id: card, text: 'CI needs no action.' })
  expect((await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'list' })).cards).toEqual([])
  const next = await h.api('POST', 'requests', { prompt: 'Investigate the CI failure' })
  const nextId = String(next.body.trigger_id)
  expect(nextId).not.toBe(id)
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: nextId, title: 'Investigate CI',
    worktree_name: 'investigate-ci', acknowledgement: 'Investigating CI.' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  const workerCards = await h.runTool(`worker-${ticketId}`, 'orchestrator_card_reply', { action: 'list' })
  expect(workerCards.cards).toEqual([expect.objectContaining({ trigger_id: nextId, ticket_id: ticketId })])
  expect(h.relays(`worker-${ticketId}`)).toContainEqual(expect.objectContaining({
    reply_card: expect.objectContaining({ ticket_id: ticketId }) }))
  expect(http.mock.calls.some(([url]) => String(url).includes('/card/instances'))).toBe(true)
})

it('rejects local requests when the default output is missing', async () => {
  h = await startRuntime()
  expect(await h.api('POST', 'requests', { prompt: 'Check CI' })).toEqual({ status: 500,
    body: { error: 'Default DingTalk output is not configured or enabled' } })
})

it('answers an admitted DingTalk question in the intake group without creating a project or enrolling the sender', async () => {
  h = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Test planner', propose: vi.fn() })
  const store = h.runtime.store
  const projects = new Projects(store)
  const send = vi.fn(async () => {})
  const kind = dingTalkKind(send)
  h.runtime.sources.register(kind)
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources,
      dingtalk: { allowed: [], admission: { group: { unlistedAddressed: 'explicit' } } } } } })
  let receive!: (frame: { headers: { messageId: string }; data: string }) => Promise<void>
  vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, listener) {
    receive = listener as typeof receive; return this
  })
  vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  new DingTalk(h.runtime.context(kind), { clientId: 'robot', clientSecret: 'test' }, () => {}, undefined, undefined, undefined,
    dingTalkProjectIntake(projects, h.runtime.projectPlanning, 'intake-group', h.runtime.projectAgent))
  const message = { msgId: 'wiki-question', conversationId: 'intake-group', conversationType: '2', isInAtList: true,
    senderStaffId: 'asker', senderCorpId: 'corp', robotCode: 'robot', msgtype: 'text', text: { content: 'Wiki 里怎么解释序列并行？' },
    sessionWebhook: 'https://oapi.dingtalk.com/robot/send?fixture', sessionWebhookExpiredTime: Date.now() + 60000 }
  const deliver = (data: typeof message) => receive({ headers: { messageId: data.msgId }, data: JSON.stringify(data) })
  await deliver({ ...message, msgId: 'unmentioned', isInAtList: false })
  await deliver({ ...message, msgId: 'other-group', conversationId: 'other' })
  await deliver(message)
  await deliver(message)
  await h.runtime.idle()
  const candidates = h.candidates()
  expect(candidates).toHaveLength(1)
  const id = String(candidates[0])
  expect(store.triggers.get(id)).toMatchObject({ source: 'dingtalk', text: message.text.content,
    channel: { source: 'dingtalk', address: { conversationId: 'intake-group' } } })
  expect(projects.directoryMemberForAccount('dingtalk', 'corp', 'asker')).toBeUndefined()
  const answer = '序列并行将部分激活沿序列维度分片。'
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'answer', trigger_id: id, text: answer })
  await h.route({ kind: 'ignore', trigger_id: id, reason: 'Answered directly.' })
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reply', text: answer,
    channel: expect.objectContaining({ address: expect.objectContaining({ conversationId: 'intake-group', triggerId: id }) }) }))
  expect(projects.list()).toEqual([])
  expect(store.tickets.list()).toEqual([])
  const ask = (msgId: string, content: string) => deliver({ ...message, msgId, text: { content } })
  await ask('enrollment-help', '请问群里的成员如何登记上来呢？')
  await h.runtime.idle()
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    text: expect.stringContaining('这个群还没有绑定项目，我会先把本人登记到成员目录'),
  }))
  expect(projects.directoryMemberForAccount('dingtalk', 'corp', 'asker')).toBeUndefined()
  await ask('register', '把我登记加入')
  await ask('register-repeat', '登记项目成员')
  await h.runtime.idle()
  expect(projects.directoryMemberForAccount('dingtalk', 'corp', 'asker')).toBeDefined()
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('已登记你的成员账号') }))
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '你的成员账号已登记。' }))
  expect(store.settings().policy.sources.dingtalk?.allowed).toEqual([])
  expect(h.candidates()).toEqual(candidates)
  await deliver({ ...message, msgId: 'wiki-follow-up', text: { content: '它能缓解什么瓶颈？' } })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'candidate',
    text: '它能缓解什么瓶颈？', recent_conversation: [{ text: message.text.content, reply: answer }] }))

  new DingTalk(h.runtime.context(kind), { clientId: 'robot', clientSecret: 'test' }, () => {}, undefined, undefined, undefined,
    dingTalkProjectIntake(projects, h.runtime.projectPlanning, undefined, h.runtime.projectAgent))
  await deliver({ ...message, msgId: 'first-in-other-group', conversationId: 'other', text: { content: '能举个例子吗？' } })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'candidate',
    text: '能举个例子吗？', recent_conversation: [] }))
})

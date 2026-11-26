/** Auditable project history joins committed facts, Agent decisions, scheduled checks and actual remote receipts. */
import { z } from 'zod'
import { statfsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { key } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { ProjectEventDefinition } from '../sources/project-events.ts'
import type { ProjectEvents } from './project-events.ts'
import type { Store } from './store.ts'
import { ProjectError, Projects, type Project } from './projects.ts'
import type { ProjectAgentRun } from './project-agent.ts'
import { taskRemoteFacts } from './repository-delivery.ts'
import { trackingOutcome } from './project-tracking.ts'

const changed: ProjectEventDefinition = { type: 'project.changed', category: 'history', internal: true,
  description: '保存已提交的项目变化及来源因果。', schema: z.strictObject({ revision: z.number(), reason: z.string(), tasks: z.array(z.string()),
    changes: z.array(z.strictObject({ field: z.string(), before: z.unknown().optional(), after: z.unknown().optional() })) }),
  defaults: { enabled: true }, documentation: 'docs/events/project-history.zh-CN.md' }
const imported: ProjectEventDefinition = { type: 'project.history.imported', category: 'history', internal: true,
  description: '记录存量基线，不重放验收或远端操作。', schema: z.strictObject({ revision: z.number(), reason: z.string(), tasks: z.array(z.strictObject({ id: z.string(), title: z.string(), status: z.string(), issueRole: z.string() })) }),
  defaults: { enabled: true }, documentation: 'docs/events/project-history.zh-CN.md' }
const progressRecorded: ProjectEventDefinition = { type: 'progress.recorded', category: 'history', internal: true,
  description: '记录任务进展及其实际作者和来源。', schema: z.strictObject({ progressId: z.string(), reason: z.string(), author: z.string(),
    source: z.string(), messageId: z.string(), corrects: z.string().optional() }),
  defaults: { enabled: true }, documentation: 'docs/events/task-tracking.zh-CN.md' }

const diskWarning = 1024 ** 3
const walWarning = 64 * 1024 ** 2
const technicalEvents = ['project.message.received', 'project.agent.proposed']
export interface ProjectHistoryFilter { taskId?: string; activityOnly?: boolean }

export function databaseStorage(db: Store['db']) {
  const path = db.location()
  const sizeOf = (filename: string) => statSync(filename, { throwIfNoEntry: false })?.size ?? 0
  const databaseBytes = path ? sizeOf(path) : 0
  const walBytes = path ? sizeOf(`${path}-wal`) : 0
  let diskAvailableBytes: number | null = null
  if (path) {
    try { const fs = statfsSync(dirname(path)); diskAvailableBytes = fs.bavail * fs.bsize }
    catch { /* The database can be on a filesystem whose capacity is not reported. */ }
  }
  const reusableBytes = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count)
    * Number(db.prepare('PRAGMA page_size').get()?.page_size)
  return { databaseBytes, walBytes, reusableBytes, diskAvailableBytes, diskWarningBytes: diskWarning, walWarningBytes: walWarning,
    diskLow: diskAvailableBytes !== null && diskAvailableBytes < diskWarning, walLarge: walBytes >= walWarning }
}

/** Records mutation facts transactionally and exposes causally linked outcomes without changing historical task state. */
export class ProjectHistory {
  constructor(private readonly store: Store, private readonly events: ProjectEvents, lifetime: AbortSignal) {
    events.register('history', [changed, imported, progressRecorded])
    for (const type of [changed.type, imported.type, progressRecorded.type]) events.handle(type, () => ({ status: 'applied' }))
    const unobserve = store.observe(KV.projects.project, (project, previous) => {
      if (!project) return
      const changes: { field: string; before: unknown; after: unknown }[] = ['name', 'objective', 'status', 'repository', 'autoAdvance', 'tracking', 'memberIds', 'milestones', 'decisions']
        .filter(field => JSON.stringify(previous?.[field as keyof Project]) !== JSON.stringify(project[field as keyof Project]))
        .map(field => ({ field, before: previous?.[field as keyof Project], after: project[field as keyof Project] }))
      const tasks: string[] = []
      const causeId = events.processing()?.id
      for (const { progress, ...task } of project.tasks) {
        const prior = previous?.tasks.find(item => item.id === task.id)
        const { progress: oldProgress, ...before } = prior ?? {}
        if (!prior || JSON.stringify(before) !== JSON.stringify(task)) {
          changes.push({ field: `task/${task.id}`, before: prior ? before : undefined, after: task }); tasks.push(task.id)
        }
        for (const entry of progress?.slice(oldProgress?.length ?? 0) ?? []) {
          events.publisher('history').publish({ id: entry.id, type: progressRecorded.type, projectId: project.id, taskId: task.id, causeId,
            data: { progressId: entry.id, reason: entry.summary, author: entry.author, source: entry.source, messageId: entry.messageId, corrects: entry.corrects } })
        }
      }
      if (!changes.length) return
      events.publisher('history').publish({ id: key(project.id, String(project.revision), JSON.stringify(changes)), type: changed.type, projectId: project.id,
        causeId,
        data: { revision: project.revision, reason: previous ? '项目变更已提交' : '项目已创建', tasks, changes } })
    })
    lifetime.addEventListener('abort', unobserve, { once: true })
  }

  /** One-time, per-project baseline import; does not turn historical completion into a fresh acceptance or remote write. */
  recover(): void {
    this.store.atomic(() => {
      for (const entry of this.store.keys(KV.projects.project)) {
        const project = this.store.get(entry)!
        if (this.store.get(KV.projects.historyBaseline(project.id))) continue
        this.events.publisher('history').publish({ id: key('project-history-baseline', project.id), type: imported.type, projectId: project.id,
          data: { revision: project.revision, reason: '导入已有状态；历史 Issue 关联未明确负责解决时按仅参考处理，不补发验收或关闭动作。',
            tasks: project.tasks.map(task => ({ id: task.id, title: task.title, status: task.status, issueRole: task.issueRole ?? 'reference' })) } })
        this.store.set(KV.projects.historyBaseline(project.id), true)
      }
    })
  }

  /** Read-only measurements scoped to the current project's history. */
  statistics(projectId: string, at = new Date()) {
    if (!this.store.get(KV.projects.project(projectId))) throw new ProjectError(404, 'Project not found')
    const { db } = this.store
    const since = new Date(at.getTime() - 7 * 86_400_000).toISOString()
    const totalEvents = Number(db.prepare("SELECT count(*) AS total FROM project_event WHERE value ->> '$.projectId' = ?").get(projectId)?.total)
    const types = db.prepare(`SELECT value ->> '$.type' AS type, count(*) AS count, sum(length(CAST(value AS BLOB))) AS payloadBytes
      FROM project_event WHERE value ->> '$.projectId' = ? AND recorded_at >= ? AND recorded_at <= ? GROUP BY type ORDER BY payloadBytes DESC, type`)
      .all(projectId, since, at.toISOString()).map(row => ({ type: String(row.type), count: Number(row.count), payloadBytes: Number(row.payloadBytes) }))
    const recent = types.reduce((total, row) => ({ count: total.count + row.count, payloadBytes: total.payloadBytes + row.payloadBytes }), { count: 0, payloadBytes: 0 })
    const counts = db.prepare(`SELECT count(*) AS total, coalesce(sum(value ->> '$.status' = 'pending'), 0) AS pending,
      coalesce(sum(value ->> '$.status' = 'dropped'), 0) AS dropped
      FROM outbox WHERE value ->> '$.origin.projectId' = ?`).get(projectId)!
    return { measuredAt: at.toISOString(), since, totalEvents, recent, types,
      receipts: { total: Number(counts.total), pending: Number(counts.pending), dropped: Number(counts.dropped) } }
  }

  view(projectId: string, before?: number, filter: ProjectHistoryFilter = {}) {
    const project = new Projects(this.store).detail(projectId)
    const matched = this.events.list({ projectId, limit: 101, before, taskId: filter.taskId,
      excludeTypes: filter.activityOnly ? technicalEvents : undefined })
    const events = matched.slice(0, 100)
    const runs = this.store.keys(KV.projects.agentRun).map(entry => this.store.get(entry)!)
      .filter(run => run.message.projectId === projectId)
    const descriptions = new Map(this.events.view().sources.flatMap(source => source.events
      .map(event => [`${source.source}:${event.type}`, event.effective.description] as const)))
    const entries = events.map(event => {
      const data = event.data as Record<string, unknown>
      const linked = runs.filter(run => run.event?.id === event.id || run.message.messageId === event.id ||
        (typeof data.messageId === 'string' && run.message.messageId === data.messageId) ||
        (typeof data.runId === 'string' && data.runId === run.id) ||
        (!!event.causeId && (run.event?.id === event.causeId || run.id === event.causeId)))
      const label = descriptions.get(`${event.source}:${event.type}`) ?? [progressRecorded, trackingOutcome].find(item => item.type === event.type)?.description
      const receipt = event.type === trackingOutcome.type && typeof data.receiptId === 'string' ? this.store.receipts.get(data.receiptId) : undefined
      return { event, label: label ?? (event.type === changed.type ? '项目变更已提交' : event.type === imported.type ? '存量基线已导入' : event.type),
        reason: event.reason || (typeof data.reason === 'string' ? data.reason : typeof data.text === 'string' ? data.text : undefined),
        ...(receipt && { delivery: { status: receipt.status, dropped: receipt.dropped,
          ...(receipt.nativeMention !== undefined && { nativeMention: receipt.nativeMention }),
          failure: receipt.status === 'pending' ? this.store.receipts.failure(receipt.id) : undefined } }),
        decisions: linked.map((run: ProjectAgentRun) => ({ id: run.id, status: run.status, reply: run.reply, trigger: run.event?.type ?? 'project.message.received',
          steps: run.steps.map(step => ({ provider: step.provider, calls: step.calls, results: step.results, error: step.error })) })) }
    })
    return { entries, next: matched.length > events.length ? events.at(-1)!.seq : null,
      notifications: this.store.receipts.forProject(projectId).map(item => ({ id: item.id, origin: item.origin!, status: item.status, nativeMention: item.nativeMention,
        source: item.channel.source, format: item.format ?? 'text', text: item.text, dropped: item.dropped,
        ...(item.status === 'pending' && this.store.get(KV.projects.trackingReminder(item.id)) && { failure: this.store.receipts.failure(item.id) }) })),
      synchronization: this.store.keys(KV.projects.issueSync).map(entry => this.store.get(entry)!).filter(item => item.projectId === projectId),
      remote: project.tasks.flatMap(task => taskRemoteFacts(this.store, project, task).map(fact => ({ taskId: task.id, ...fact }))),
      checks: this.store.keys(KV.projects.check).map(entry => this.store.get(entry)!).filter(check => check.projectId === projectId) }
  }
}

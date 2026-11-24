import { useId, useRef, useState, type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { ProjectDetail, ProjectTask } from '../app/projects.ts'
import { currentReview, deliveryReviewState } from '../app/project-deliveries.ts'
import { usePoll, type Call } from './api.ts'
import { Button, Icon, SegmentedTabs, Tag, type IconName, type TagTone } from './controls.tsx'
import { errorText, formatBytes, type T } from './text.ts'
import { MarkdownContent } from './widgets.tsx'

type History = ApiResponse<'GET projects/:id/history'>
type Entry = History['entries'][number]
type Statistics = ApiResponse<'GET projects/:id/history/statistics'>
type Receipt = History['notifications'][number]
type TrackingOutcome = { state: 'queued' | 'quiet' | 'skipped' | 'failed'; provider?: string;
  suggestion?: { reason: string; question: string } }
const views = ['activity', 'work', 'notifications', 'repository', 'statistics'] as const
type HistoryView = typeof views[number]
type OpenTask = (task: ProjectTask) => void

const dateOf = (value: string) => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' })
const timeOf = (value: string) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const deliveryTone = { sent: 'success', pending: 'warning', dropped: 'danger' } as const
const outcomeTone = { queued: 'info', quiet: 'quiet', skipped: 'quiet', failed: 'danger' } as const
const syncTone: Record<History['synchronization'][number]['status'], TagTone> = {
  succeeded: 'success', cancelled: 'quiet', failed: 'danger', retrying: 'warning', pending: 'info',
}
const trackingOutcome = (item: Entry) => item.event.type === 'tracking.check.resolved' ? item.event.data as TrackingOutcome : undefined

function eventText(item: Entry, t: T, taskName: (id: string) => string) {
  const outcome = trackingOutcome(item)
  if (outcome) return { title: t('project.history.followupResult'), summary: outcome.suggestion?.question || item.reason }
  if (item.event.type === 'progress.recorded') return { title: t('project.history.progressRecorded'), summary: item.reason }
  if (item.event.type === 'project.changed') {
    type TaskChange = { field: string; before?: Pick<ProjectTask, 'status'>; after?: Pick<ProjectTask, 'title' | 'status'> }
    const changes = (item.event.data as { changes?: TaskChange[] }).changes?.filter(change => change.field.startsWith('task/')) ?? []
    if (changes.length === 1) {
      const { field, before, after } = changes[0]!
      const title = after?.title || taskName(field.slice('task/'.length))
      if (!before) return { title: t('project.history.taskCreated', { task: title }), summary: undefined }
      if (after && before.status !== after.status) return { title, summary: t('project.history.taskMoved', {
        from: t(`project.state.${before.status}`), to: t(`project.state.${after.status}`),
      }) }
      return { title: t('project.history.taskUpdated', { task: title }), summary: undefined }
    }
    if (changes.length > 1) return { title: t('project.history.tasksUpdated', { count: changes.length }), summary: undefined }
  }
  return { title: item.label, summary: item.reason }
}

function eventStatus(item: Entry, t: T): { label: string; tone: TagTone } {
  if (item.delivery) return { label: t(`project.notification.${item.delivery.status}`), tone: deliveryTone[item.delivery.status] }
  const outcome = trackingOutcome(item)
  if (outcome) return { label: t(`project.tracking.outcome.${outcome.state}`), tone: outcomeTone[outcome.state] }
  const tone = item.event.status === 'pending' ? 'warning' : item.event.status === 'applied' ? 'success' : 'quiet'
  return { label: t(`project.event.${item.event.status}`), tone }
}

function eventIcon(item: Entry): IconName {
  if (item.event.type.startsWith('tracking.') || item.event.type === 'check.due') return 'clock'
  if (item.event.type.startsWith('review.') || item.event.type === 'delivery.ready') return 'review'
  if (item.event.type.startsWith('project.message')) return 'message'
  if (item.event.type === 'task.blocked') return 'alert'
  return 'history'
}

function Metric({ icon, label, value, onClick }: { icon: IconName; label: string; value?: number; onClick: () => void }) {
  return <button type="button" className="dt-history-metric" data-attention={!!value} onClick={onClick}>
    <span className="dt-history-metric-icon"><Icon name={icon} /></span>
    <span className="dt-history-metric-label">{label}</span>
    <strong>{value ?? '—'}</strong>
    <Icon name="chevron-right" size={13} />
  </button>
}

function Empty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <div className="dt-history-empty"><Icon name={icon} size={20} /><p>{children}</p></div>
}

function EventInspector({ item, t, taskName, openCause }: { item: Entry; t: T; taskName: (id: string) => string; openCause?: () => void }) {
  const status = eventStatus(item, t)
  const outcome = trackingOutcome(item)
  const { title, summary } = eventText(item, t, taskName)
  return <article className="dt-history-inspector" aria-label={t('project.history.eventDetail')}>
    <header>
      <div className="dt-project-meta"><Icon name={eventIcon(item)} size={14} />
        <span>{item.event.source}</span><span>·</span><time dateTime={item.event.recordedAt}>{dateOf(item.event.recordedAt)} {timeOf(item.event.recordedAt)}</time>
      </div>
      <h4>{title}</h4>
      <div className="dt-project-meta">
        <Tag tone={status.tone}>{status.label}</Tag>{item.event.taskId && <span>{taskName(item.event.taskId)}</span>}
      </div>
    </header>
    {summary && summary !== title && <MarkdownContent t={t} text={summary} />}
    {outcome?.suggestion && <div className="dt-history-detail-block">
      <strong>{t('project.history.decisionReason')}</strong>
      <MarkdownContent t={t} text={outcome.suggestion.reason} />
      {outcome.provider && <span className="dt-hint">{outcome.provider}</span>}
    </div>}
    {item.delivery?.failure && <p className="dt-error">{item.delivery.failure}</p>}
    {item.delivery?.dropped && <p className="dt-hint">{t(`project.tracking.drop.${item.delivery.dropped.reason}`)}</p>}
    {item.reason && outcome?.suggestion && item.reason !== summary && <p className="dt-hint">{item.reason}</p>}
    {item.decisions.map(decision => <details className="dt-history-detail-block" key={decision.id}>
      <summary>{t('project.agentDecision')} <Tag>{t(`project.history.agent.${decision.status}`)}</Tag></summary>
      {decision.reply ? <MarkdownContent t={t} text={decision.reply} /> : <p className="dt-hint">{t(decision.status === 'running' ? 'project.decisionPending' : 'project.silentDecision')}</p>}
      {decision.steps.map((step, index) => <div key={index}>
        <p className="dt-hint">{step.provider} · {step.calls.map(call => call.tool).join(', ')}</p>
        {step.error ? <p className="dt-error">{step.error}</p> : <ul>{step.results.map((result, index) => <li key={index}>{result.summary}</li>)}</ul>}
      </div>)}
    </details>)}
    <details className="dt-history-detail-block">
      <summary>{t('project.eventEvidence')}</summary>
      <p className="dt-project-meta"><code>#{item.event.seq}</code><code>{item.event.type}</code></p>
      {item.event.causeId && <p className="dt-project-meta">{t('project.cause')} <code>{item.event.causeId}</code>
        {openCause && <Button size="sm" variant="outline" onClick={openCause}>{t('project.history.openCause')}</Button>}</p>}
      <pre className="dt-history-json">{JSON.stringify(item.event.data, null, 2)}</pre>
    </details>
  </article>
}

function Activity({ t, project, history, taskId, setTaskId, technical, setTechnical, before, setBefore, taskName }: {
  t: T; project: ProjectDetail; history?: History; taskId: string; setTaskId: (id: string) => void; technical: boolean
  setTechnical: (value: boolean) => void; before?: number; setBefore: (value?: number) => void; taskName: (id: string) => string
}) {
  const [eventSeq, setEventSeq] = useState<number>()
  const inspector = useRef<HTMLDivElement>(null)
  const entries = history?.entries ?? []
  const selected = entries.find(item => item.event.seq === eventSeq) ?? entries[0]
  const days = new Map<string, Entry[]>()
  for (const item of entries) {
    const date = dateOf(item.event.recordedAt)
    const records = days.get(date) ?? []
    records.push(item)
    days.set(date, records)
  }
  const choose = (seq: number) => {
    setEventSeq(seq)
    inspector.current?.scrollIntoView?.({ block: 'nearest' })
  }
  const parent = selected?.event.causeId && entries.find(item => item.event.id === selected.event.causeId)
  return <>
    <div className="dt-history-filters">
      <label className="dt-history-filter"><span>{t('project.relatedTask')}</span>
        <select className="dt-select" value={taskId} onChange={event => { setEventSeq(undefined); setTaskId(event.target.value) }}>
          <option value="">{t('project.allTasks')}</option>
          {project.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
      </label>
      <label className="dt-history-checkbox"><input type="checkbox" checked={technical}
        onChange={event => { setEventSeq(undefined); setTechnical(event.target.checked) }} />{t('project.history.showTechnical')}</label>
    </div>
    {!history ? <p role="status" className="dt-hint">{t('loading')}</p> : !selected
      ? <Empty icon="history">{t('project.history.noActivity')}</Empty>
      : <div className="dt-history-timeline">
        <div className="dt-history-list" aria-label={t('project.history.view.activity')}>
          {[...days].map(([date, items]) => <section className="dt-history-day" key={date}>
            <h4>{date}</h4>
            <ol>{items.map(item => {
              const status = eventStatus(item, t)
              const { title, summary } = eventText(item, t, taskName)
              return <li key={item.event.seq}><button type="button" className="dt-history-event" aria-pressed={item === selected}
                onClick={() => choose(item.event.seq)}>
                <span className="dt-history-event-icon" data-tone={status.tone}><Icon name={eventIcon(item)} size={15} /></span>
                <span className="dt-history-event-content">
                  <span className="dt-history-event-meta"><time dateTime={item.event.recordedAt}>{timeOf(item.event.recordedAt)}</time>
                    <span>{item.event.taskId ? taskName(item.event.taskId) : item.event.source}</span></span>
                  <strong>{title}</strong>
                  {summary && summary !== title && <span className="dt-history-event-preview">{summary}</span>}
                  <Tag tone={status.tone}>{status.label}</Tag>
                </span>
              </button></li>
            })}</ol>
          </section>)}
        </div>
        <div className="dt-history-inspector-slot" ref={inspector}>
          <EventInspector key={selected.event.seq} item={selected} t={t} taskName={taskName}
            openCause={parent ? () => choose(parent.event.seq) : undefined} />
        </div>
      </div>}
    {(before || history?.next) && <div className="dt-history-pagination">
      {before && <Button size="sm" variant="outline" icon={<Icon name="chevron-left" size={13} />} onClick={() => { setEventSeq(undefined); setBefore() }}>{t('project.latestEvents')}</Button>}
      {history?.next && <Button size="sm" variant="outline" icon={<Icon name="history" size={13} />}
        onClick={() => { setEventSeq(undefined); setBefore(history.next!) }}>{t('project.olderEvents')}</Button>}
    </div>}
  </>
}

function PendingWork({ t, project, answers, reviews, checks, taskName, openTask, openTicket }: { t: T; project: ProjectDetail; answers: ProjectDetail['tickets'];
  reviews: ProjectTask[]; checks: History['checks']; taskName: (id: string) => string; openTask?: OpenTask; openTicket?: (id: string) => void }) {
  const memberNames = new Map(project.members.map(item => [item.id, item.name]))
  return <>
    {!answers.length && !reviews.length && <Empty icon="decision">{t('project.history.noWork')}</Empty>}
    {!!answers.length && <section className="dt-history-bucket"><h4>{t('project.history.pendingAnswers')}</h4>
      <ul className="dt-history-records">{answers.map(ticket => {
        const task = project.tasks.find(item => item.id === ticket.taskId || item.ticketId === ticket.id)
        return <li key={ticket.id} className="dt-history-record">
          <span className="dt-history-record-icon"><Icon name="ask" /></span>
          <div><strong>{task?.title ?? ticket.title}</strong>
            {ticket.question && <MarkdownContent t={t} text={ticket.question} />}
          </div>
          {openTicket ? <Button variant="outline" size="sm" onClick={() => openTicket(ticket.id)}>{t('project.openTicket')}</Button>
            : task && openTask && <Button variant="outline" size="sm" onClick={() => openTask(task)}>{t('project.history.openTask')}</Button>}
        </li>
      })}</ul>
    </section>}
    {!!reviews.length && <section className="dt-history-bucket"><h4>{t('project.history.pendingReviews')}</h4>
      <ul className="dt-history-records">{reviews.map(task => {
        const review = currentReview(task)
        const reviewTask = review?.taskId && project.tasks.find(item => item.id === review.taskId)
        const reviewerId = reviewTask ? reviewTask.ownerId : review?.requirements.ownerId
        const owner = reviewerId && memberNames.get(reviewerId)
        return <li key={task.id} className="dt-history-record">
          <span className="dt-history-record-icon"><Icon name="review" /></span>
          <div><strong>{task.title}</strong>
            <p className="dt-project-meta">{t('project.tracking.awaitingReview', { version: review?.version ?? '—', owner: owner || t('project.unassigned') })}</p>
          </div>
          {openTask && <Button size="sm" variant="outline" onClick={() => openTask(reviewTask || task)}>{t('project.history.openTask')}</Button>}
        </li>
      })}</ul>
    </section>}
    {!!checks.length && <section className="dt-history-bucket"><h4>{t('project.scheduledChecks')}</h4>
      <ul className="dt-history-records">{checks.map(check => <li key={check.id} className="dt-history-record">
        <span className="dt-history-record-icon"><Icon name="clock" /></span>
        <div><strong>{taskName(check.taskId)}</strong><p>{check.reason}</p><p className="dt-project-meta">
          <time dateTime={check.at}>{dateOf(check.at)} {timeOf(check.at)}</time></p></div>
        <Tag tone={check.fired ? 'quiet' : 'info'}>{t(check.fired ? 'project.checkFired' : 'project.checkWaiting')}</Tag>
      </li>)}</ul>
    </section>}
  </>
}

function Notifications({ t, records, filter, setFilter, taskName, total }: { t: T; records: Receipt[]; filter: Receipt['status'] | '';
  setFilter: (value: Receipt['status'] | '') => void; taskName: (id: string) => string; total?: number }) {
  const statuses = ['pending', 'sent', 'dropped'] as const
  const visible = records.filter(item => !filter || item.status === filter)
  return <>
    <div className="dt-history-filters">
      <label className="dt-history-filter"><span>{t('project.history.deliveryStatus')}</span>
        <select className="dt-select" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
          <option value="">{t('project.history.allStatuses')}</option>
          {statuses.map(status => <option key={status} value={status}>{t(`project.notification.${status}`)}</option>)}
        </select>
      </label>
      {total !== undefined && total > records.length && <p className="dt-hint">{t('project.history.recentReceipts', { count: records.length })}</p>}
    </div>
    {!visible.length ? <Empty icon="inbox">{t('project.history.noNotifications')}</Empty>
      : <ul className="dt-history-records">{visible.map(item => <li key={item.id} className="dt-history-record">
        <span className="dt-history-record-icon"><Icon name="message" /></span>
        <div>
          <div className="dt-project-meta"><Tag tone={deliveryTone[item.status]}>{t(`project.notification.${item.status}`)}</Tag>
            <span>{item.source}</span>{item.origin.taskId && <strong>{taskName(item.origin.taskId)}</strong>}</div>
          <details className="dt-history-message"><summary>{item.text.split('\n').find(line => line.trim())?.trim() || t('project.eventEvidence')}</summary>
            <MarkdownContent t={t} text={item.text} />
            <p className="dt-project-meta">{item.format} · <code>{item.id}</code>{item.origin.eventId && <> · <code>{item.origin.eventId}</code></>}</p>
          </details>
          {item.failure && <p className="dt-error">{item.failure}</p>}
          {item.dropped && <p className="dt-hint">{t(`project.tracking.drop.${item.dropped.reason}`)}</p>}
        </div>
      </li>)}</ul>}
  </>
}

function RepositoryHistory({ t, operations, facts, onlyFailures, setOnlyFailures, pending, retry, taskName }: { t: T;
  operations: History['synchronization']; facts: History['remote']; onlyFailures: boolean; setOnlyFailures: (value: boolean) => void
  pending: string; retry: (id: string) => Promise<void>; taskName: (id: string) => string;
}) {
  const visible = operations.filter(item => !onlyFailures || ['failed', 'retrying'].includes(item.status))
  return <>
    <div className="dt-history-filters"><label className="dt-history-checkbox"><input type="checkbox" checked={onlyFailures}
      onChange={event => setOnlyFailures(event.target.checked)} />{t('project.history.onlySyncIssues')}</label></div>
    {!visible.length && <Empty icon="pull">{t('project.history.noSync')}</Empty>}
    {!!visible.length && <ul className="dt-history-records">{visible.map(item => <li key={item.id} className="dt-history-record">
      <span className="dt-history-record-icon"><Icon name="pull" /></span>
      <div><div className="dt-project-meta"><strong>{taskName(item.taskId)}</strong><Tag tone={syncTone[item.status]}>{t(`project.sync.${item.status}`)}</Tag></div>
        <p>{item.reason}</p><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a>
        <p className="dt-project-meta"><time dateTime={item.updatedAt}>{dateOf(item.updatedAt)} {timeOf(item.updatedAt)}</time> · {t('project.attempts', { count: item.attempts })}</p></div>
      {['failed', 'retrying'].includes(item.status) && <Button size="sm" variant="outline" disabled={!!pending}
        onClick={() => { void retry(item.id) }}>{t('project.retrySync')}</Button>}
    </li>)}</ul>}
    {!!facts.length && <details className="dt-history-detail-block"><summary>{t('project.remoteFacts')}</summary>
      <ul className="dt-history-records">{facts.map(item => <li key={`${item.taskId}:${item.url}`} className="dt-history-record">
        <span className="dt-history-record-icon"><Icon name="external" /></span>
        <div><div className="dt-project-meta"><strong>{taskName(item.taskId)}</strong> <Tag>{item.state}</Tag></div>
          <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a>
          <p className="dt-project-meta">{item.head && <code>{item.head.slice(0, 12)}</code>}
            <time dateTime={item.updatedAt}>{dateOf(item.updatedAt)} {timeOf(item.updatedAt)}</time></p>
        </div>
      </li>)}</ul>
    </details>}
  </>
}

function HistoryStatistics({ t, data, error }: { t: T; data?: Statistics; error?: Error }) {
  if (!data) return <p role="status" className="dt-hint">{error?.message ?? t('loading')}</p>
  const maxBytes = data.types[0]?.payloadBytes || 1
  return <>
    {error && <p role="status" className="dt-hint">{error.message}</p>}
    <section className="dt-history-bucket"><h4>{t('project.history.storageProject')}</h4>
      <dl className="dt-project-stats">
        <div><dt>{t('project.history.eventsWeek')}</dt><dd>{data.recent.count.toLocaleString()}</dd></div>
        <div><dt>{t('project.history.payloadWeek')}</dt><dd>{formatBytes(data.recent.payloadBytes)}</dd></div>
        <div><dt>{t('project.history.totalEvents')}</dt><dd>{data.totalEvents.toLocaleString()}</dd></div>
        <div><dt>{t('project.history.totalReceipts')}</dt><dd>{data.receipts.total.toLocaleString()}</dd></div>
      </dl>
    </section>
    <p className="dt-hint">{t('project.history.storageHelp')}</p>
    {!!data.types.length && <section className="dt-history-bucket"><h4>{t('project.history.eventTypes')}</h4>
      <ul className="dt-history-breakdown">{data.types.map(item => <li key={item.type}>
        <span><code>{item.type}</code><strong>{formatBytes(item.payloadBytes)}</strong></span>
        <span className="dt-history-bar" aria-hidden="true"><span style={{ width: `${100 * item.payloadBytes / maxBytes}%` }} /></span>
        <small>{t('project.history.eventCount', { count: item.count })}</small>
      </li>)}</ul>
    </section>}
  </>
}

/** Surfaces current actions and business events while keeping delivery, repository and storage detail one view away. */
export function ProjectHistory({ call, t, project, openTask, openTicket }: { call: Call; t: T; project: ProjectDetail; openTask?: OpenTask; openTicket?: (id: string) => void }) {
  const scope = useId()
  const [view, setView] = useState<HistoryView>('activity')
  const [before, setBefore] = useState<number>()
  const [taskId, setTask] = useState('')
  const [technical, setTechnical] = useState(false)
  const [notificationStatus, setNotificationStatus] = useState<Receipt['status'] | ''>('')
  const [onlyFailures, setOnlyFailures] = useState(false)
  const [failure, setFailure] = useState('')
  const [pending, setPending] = useState('')
  const pageKey = JSON.stringify([project.id, before, taskId, technical])
  const history = usePoll(async () => ({ key: pageKey, data: await call('GET projects/:id/history', { id: project.id,
    query: { before, taskId: taskId || undefined, activityOnly: !technical } }) }), [call, pageKey])
  const data = history.data?.data
  const stats = usePoll(() => call('GET projects/:id/history/statistics', { id: project.id }), [call, project.id], 60_000)
  const retry = async (operationId: string) => {
    setPending(operationId); setFailure('')
    try { await call('POST projects/:id/synchronization/:operationId/retry', { id: project.id, operationId }); await history.reload() }
    catch (error) { setFailure(errorText(error)) }
    finally { setPending('') }
  }
  const taskName = (id: string) => project.tasks.find(task => task.id === id)?.title ?? id.slice(0, 8)
  const ticketIds = new Set(project.tasks.flatMap(task => task.ticketId ?? []))
  const answers = project.tickets.filter(ticket => (ticket.taskId || ticketIds.has(ticket.id)) && ticket.stage === 'person' &&
    ticket.action === 'answer' && !ticket.answerSubmitted)
  const reviews = project.tasks.filter(task => deliveryReviewState(task).status === 'pending')
  const operations = data?.synchronization ?? []
  const tabs = views.map(value => ({ value, label: t(`project.history.view.${value}`), id: `${scope}-${value}`, panelId: `${scope}-panel-${value}` }))
  const tab = tabs.find(item => item.value === view)!
  return <section className="dt-history">
    <header className="dt-history-header"><h3>{t('project.history')}</h3></header>
    <div className="dt-history-overview" role="group" aria-label={t('project.history.priority')}>
      <Metric icon="ask" label={t('project.history.pendingAnswers')} value={answers.length} onClick={() => setView('work')} />
      <Metric icon="review" label={t('project.history.pendingReviews')} value={reviews.length} onClick={() => setView('work')} />
      <Metric icon="inbox" label={t('project.history.pendingReceipts')} value={stats.data?.receipts.pending}
        onClick={() => { setNotificationStatus('pending'); setView('notifications') }} />
      <Metric icon="pull" label={t('project.history.failedSync')} value={data && operations.filter(item => item.status === 'failed' || item.status === 'retrying').length}
        onClick={() => { setOnlyFailures(true); setView('repository') }} />
    </div>
    <div className="dt-history-body">
      <SegmentedTabs className="dt-history-tabs" label={t('project.history')} items={tabs} value={view} onChange={setView} />
      <section className="dt-history-view" role="tabpanel" id={tab.panelId} aria-labelledby={tab.id}>
        {(failure || history.error) && <p role="alert" className="dt-error">{failure || history.error?.message}</p>}
        {view === 'activity' && <Activity t={t} project={project} history={history.data?.key === pageKey ? data : undefined} taskId={taskId} setTaskId={value => { setTask(value); setBefore(undefined) }}
          technical={technical} setTechnical={value => { setTechnical(value); setBefore(undefined) }} before={before} setBefore={setBefore} taskName={taskName} />}
        {view === 'work' && <PendingWork t={t} project={project} answers={answers} reviews={reviews} checks={data?.checks ?? []}
          taskName={taskName} openTask={openTask} openTicket={openTicket} />}
        {view === 'notifications' && (data ? <Notifications t={t} records={data.notifications} filter={notificationStatus}
          setFilter={setNotificationStatus} taskName={taskName} total={stats.data?.receipts.total} /> : <p role="status">{t('loading')}</p>)}
        {view === 'repository' && (data ? <RepositoryHistory t={t} operations={operations} facts={data.remote} onlyFailures={onlyFailures}
          setOnlyFailures={setOnlyFailures} pending={pending} retry={retry} taskName={taskName} /> : <p role="status">{t('loading')}</p>)}
        {view === 'statistics' && <HistoryStatistics t={t} data={stats.data} error={stats.error} />}
      </section>
    </div>
  </section>
}

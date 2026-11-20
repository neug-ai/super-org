import { useId, useState } from 'react'
import { usePoll, type Call } from './api.ts'
import { SegmentedTabs, Tag } from './controls.tsx'
import { TicketRecords } from './project-sections.tsx'
import { formatBytes, fullTime, type T } from './text.ts'

const views = ['executions', 'events', 'storage'] as const
type WorkspaceView = typeof views[number]
type Props = { t: T; call: Call }

function WorkspaceExecutions({ t, call, openTicket }: Props & { openTicket?: (id: string) => void }) {
  const { data, error } = usePoll(() => call('GET projects/recent-tickets'), [call], 30_000)
  return <>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {!data ? !error && <p role="status">{t('loading')}</p>
      : data.length ? <><p className="dt-hint">{t('project.workspaceRecords.recentExecutions')}</p>
        <TicketRecords t={t} tickets={data} openTicket={openTicket} /></>
        : <p className="dt-hint">{t('project.workspaceRecords.noExecutions')}</p>}
  </>
}

function WorkspaceEvents({ t, call }: Props) {
  const { data, error } = usePoll(() => call('GET projects/events', { query: { workspaceOnly: true, limit: 50 } }), [call], 30_000)
  return <>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {!data ? !error && <p role="status">{t('loading')}</p>
      : data.length ? <ol className="dt-project-records">{data.map(event => <li className="dt-project-record" key={event.seq}>
        <div className="dt-project-record-head"><strong>{event.type}</strong>
          <Tag tone={event.status === 'applied' ? 'success' : event.status === 'pending' ? 'warning' : 'quiet'}>{t(`project.event.${event.status}`)}</Tag></div>
        <p className="dt-project-meta"><span>{event.source}</span>
          <time dateTime={event.recordedAt}>{fullTime(event.recordedAt, t('lang'))}</time></p>
        {event.reason && <p>{event.reason}</p>}
        <details><summary>{t('project.eventEvidence')}</summary><pre className="dt-history-json">{JSON.stringify(event.data, null, 2)}</pre></details>
      </li>)}</ol> : <p className="dt-hint">{t('project.workspaceRecords.noEvents')}</p>}
  </>
}

function WorkspaceStorage({ t, call }: Props) {
  const { data, error } = usePoll(() => call('GET projects/workspace/storage'), [call], 60_000)
  return <>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {data ? <>
      {data.diskLow && <p role="alert" className="dt-error">{t('project.history.diskLow')}</p>}
      {data.walLarge && <p role="alert" className="dt-error">{t('project.history.walLarge')}</p>}
      <section className="dt-history-bucket"><h4>{t('project.history.storageShared')}</h4>
        <dl className="dt-project-stats">
          <div><dt>{t('project.history.database')}</dt><dd>{formatBytes(data.databaseBytes)}</dd></div>
          <div><dt>{t('project.history.wal')}</dt><dd>{formatBytes(data.walBytes)}</dd></div>
          <div><dt>{t('project.history.reusable')}</dt><dd>{formatBytes(data.reusableBytes)}</dd></div>
          <div><dt>{t('project.history.diskAvailable')}</dt><dd>{formatBytes(data.diskAvailableBytes)}</dd></div>
        </dl>
      </section>
      <details className="dt-history-detail-block"><summary>{t('project.history.maintenance')}</summary><p>{t('project.history.maintenanceHelp')}</p></details>
    </> : !error && <p role="status">{t('loading')}</p>}
  </>
}

export function WorkspaceRecords({ t, call, openTicket }: Props & { openTicket?: (id: string) => void }) {
  const scope = useId()
  const [view, setView] = useState<WorkspaceView>('executions')
  const tabs = views.map(value => ({ value, label: t(`project.workspaceRecords.${value}`), id: `${scope}-${value}`, panelId: `${scope}-panel-${value}` }))
  const tab = tabs.find(item => item.value === view)!
  return <section className="dt-history" aria-label={t('project.workspaceRecords')}>
    <header className="dt-history-header"><h3>{t('project.workspaceRecords')}</h3></header>
    <div className="dt-history-body">
      <SegmentedTabs className="dt-history-tabs" label={t('project.workspaceRecords')} items={tabs} value={view} onChange={setView} />
      <section className="dt-history-view" role="tabpanel" id={tab.panelId} aria-labelledby={tab.id}>
        {view === 'executions' && <WorkspaceExecutions t={t} call={call} openTicket={openTicket} />}
        {view === 'events' && <WorkspaceEvents t={t} call={call} />}
        {view === 'storage' && <WorkspaceStorage t={t} call={call} />}
      </section>
    </div>
  </section>
}

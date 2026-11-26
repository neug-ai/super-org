import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'
import type { SQLInputValue } from 'node:sqlite'
import type { ChannelRef } from '../core/index.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

const MESSAGE = "run.value -> '$.message'"
const PROJECT = `${MESSAGE} ->> '$.projectId'`
const SOURCE = `${MESSAGE} ->> '$.channel.source'`
const THREAD = `${MESSAGE} ->> '$.channel.thread'`
const AT = `coalesce(${MESSAGE} ->> '$.sentAt', run.value ->> '$.at')`
const HUMAN_TURN = `run.key GLOB '${KV.projects.agentRun.prefix}*' AND run.value -> '$.event' IS NULL`
const COMPLETED = `${HUMAN_TURN} AND run.value ->> '$.status' = 'completed'`
const SENT = "reply.value ->> '$.status' = 'sent' AND reply.value ->> '$.origin.runId' IS NOT NULL"

/** Index the existing records so older installations can search without copying or replaying messages. */
export const PROJECT_CONVERSATION_INDEXES = `
  CREATE INDEX IF NOT EXISTS project_conversation_runs ON kv(${PROJECT.replaceAll('run.', '')}, ${SOURCE.replaceAll('run.', '')},
    ${THREAD.replaceAll('run.', '')}, ${AT.replaceAll('run.', '')}) WHERE ${HUMAN_TURN.replaceAll('run.', '')};
  CREATE INDEX IF NOT EXISTS project_conversation_replies ON outbox(value ->> '$.origin.runId') WHERE ${SENT.replaceAll('reply.', '')};
`

const NATIVE = `coalesce(${MESSAGE} ->> '$.nativeMessageId', source.value ->> '$.meta.messageId')`
const PARENT = `coalesce(${MESSAGE} ->> '$.replyToNativeMessageId', source.value ->> '$.meta.replyToMessageId',
  source.value ->> '$.meta.parentId')`

const DELIVERED_REPLY = `
  LEFT JOIN outbox reply ON reply.rowid = (
    SELECT reply.rowid FROM outbox reply
    WHERE reply.value ->> '$.origin.runId' = run.value ->> '$.id' AND ${SENT}
      AND reply.value ->> '$.origin.projectId' = ${PROJECT} AND reply.value ->> '$.channel.source' = ${SOURCE}
      AND reply.value ->> '$.channel.thread' = ${THREAD}
    ORDER BY reply.rowid DESC LIMIT 1
  )`

const TURN = (from = 'kv run') => `
  SELECT run.value ->> '$.id' AS id,
    ${NATIVE} AS nativeId,
    coalesce(${MESSAGE} ->> '$.sourceUrl', source.value ->> '$.url') AS url, ${MESSAGE} ->> '$.actorId' AS actorId,
    ${AT} AS at, ${MESSAGE} ->> '$.text' AS text, reply.value ->> '$.text' AS reply
  FROM ${from}
  LEFT JOIN trigger source ON source.id = ${MESSAGE} ->> '$.messageId'
    AND source.value ->> '$.source' = ${SOURCE} AND source.value ->> '$.channel.thread' = ${THREAD}
  ${DELIVERED_REPLY}
  WHERE ${COMPLETED} AND ${PROJECT} = ? AND ${SOURCE} = ? AND ${THREAD} = ?`

type Scope = { projectId: string; channel: ChannelRef }
type Turn = { id: string; nativeId: string | null; url: string | null; actorId: string | null;
  at: string; text: string; reply: string | null }
type Search = { query: string; after?: string; before?: string }
const pageSize = 4000
const ftsTable = 'project_conversation_fts'
const indexedStores = new WeakSet<Store>()
let jieba: Jieba | undefined

/** Use the same segmentation for indexed text and queries. SQLite still owns BM25 and token matching. */
export function projectHistoryTokens(text: string): string[] {
  return (jieba ??= Jieba.withDict(dict)).cut(text.normalize('NFKC'), true)
    .flatMap(piece => piece.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [])
}

type IndexRow = { key: string; text: string | null; reply: string | null }
function indexRow(store: Store, row: IndexRow) {
  const mapping = row.text === null
    ? store.db.prepare('SELECT id FROM project_conversation_search_key WHERE run_key = ?').get(row.key)
    : store.db.prepare(`INSERT INTO project_conversation_search_key(run_key) VALUES (?)
      ON CONFLICT(run_key) DO UPDATE SET run_key = excluded.run_key RETURNING id`).get(row.key)
  if (!mapping) return
  const id = Number(mapping.id)
  store.db.prepare(`DELETE FROM ${ftsTable} WHERE rowid = ?`).run(id)
  if (row.text !== null) store.db.prepare(`INSERT INTO ${ftsTable}(rowid, message_tokens, reply_tokens) VALUES (?, ?, ?)`)
    .run(id, projectHistoryTokens(row.text).join(' '), projectHistoryTokens(row.reply ?? '').join(' '))
}

/** Populate an additive index once and keep its input in the same transactions as history records. */
export function initializeProjectConversationSearch(store: Store) {
  const existed = store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(ftsTable)
  try {
    store.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable}
      USING fts5(message_tokens, reply_tokens, tokenize='unicode61');`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such module: fts5')) return
    throw error
  }
  // KV's implicit rowids may change during VACUUM. The explicit integer keys survive it.
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS project_conversation_search_key(id INTEGER PRIMARY KEY, run_key TEXT NOT NULL UNIQUE);
    CREATE TRIGGER IF NOT EXISTS project_conversation_fts_delete AFTER DELETE ON kv
    WHEN old.key GLOB '${KV.projects.agentRun.prefix}*'
    BEGIN
      DELETE FROM ${ftsTable} WHERE rowid = (SELECT id FROM project_conversation_search_key WHERE run_key = old.key);
      DELETE FROM project_conversation_search_key WHERE run_key = old.key;
    END;`)
  if (!existed) {
    const rows = store.db.prepare(`SELECT run.key, ${MESSAGE} ->> '$.text' AS text, reply.value ->> '$.text' AS reply
      FROM kv run ${DELIVERED_REPLY} WHERE ${COMPLETED}`).iterate()
    for (const row of rows) indexRow(store, row as unknown as IndexRow)
  }
  indexedStores.add(store)
  store.observe(KV.projects.agentRun, (run, previous) => {
    if (run && !run.event && (run.status === 'completed' || previous?.status === 'completed'))
      refreshProjectConversationSearch(store, run.id)
  })
}

export function refreshProjectConversationSearch(store: Store, runId: string) {
  if (!indexedStores.has(store)) return
  const row = store.db.prepare(`SELECT run.key, CASE WHEN ${COMPLETED} THEN ${MESSAGE} ->> '$.text' END AS text,
    reply.value ->> '$.text' AS reply FROM kv run ${DELIVERED_REPLY} WHERE run.key = ?`)
    .get(KV.projects.agentRun(runId)) as unknown as IndexRow | undefined
  if (row) indexRow(store, row)
}

function turns(store: Store, scope: Scope, filter: string, ...args: SQLInputValue[]): Turn[] {
  return store.db.prepare(TURN() + filter).all(scope.projectId, scope.channel.source, scope.channel.thread, ...args) as unknown as Turn[]
}
function reference(turn: Turn) {
  return { messageId: turn.id, at: turn.at, actorId: turn.actorId, url: turn.url }
}
function excerpt(text: string, offset = 0) {
  const start = Math.max(0, offset - 45)
  const end = start + 240
  return (start ? '…' : '') + text.slice(start, end) + (text.length > end ? '…' : '')
}

export function recentProjectConversation(store: Store, scope: Scope, runId: string) {
  return turns(store, scope, ` AND run.key != ? ORDER BY ${AT} DESC, run.rowid DESC LIMIT 5`, KV.projects.agentRun(runId))
    .reverse().map(turn => ({ text: turn.text.slice(0, 2000), reply: turn.reply }))
}

export function webConversation(store: Store, projectId: string) {
  const rows = store.db.prepare(`SELECT run.value ->> '$.id' AS id, ${AT} AS at, ${MESSAGE} ->> '$.text' AS text,
    run.value ->> '$.reply' AS reply, run.value ->> '$.status' AS status
    FROM kv run WHERE ${HUMAN_TURN} AND ${PROJECT} = ? AND ${SOURCE} = 'request' AND ${THREAD} = ?
    ORDER BY ${AT} DESC, run.rowid DESC LIMIT 20`).all(projectId, projectId)
  return (rows as unknown as { id: string; at: string; text: string; reply: string | null;
    status: 'running' | 'completed' | 'failed' }[]).reverse()
}

export function searchConversation(store: Store, scope: Scope, input: Search) {
  const range = [
    ...(input.after ? [`AND ${AT} >= ?`] : []),
    ...(input.before ? [`AND ${AT} < ?`] : []),
  ].join(' ')
  const params = [input.after, input.before].flatMap(value => value ? [new Date(value).toISOString()] : [])
  const tokens = [...new Set(projectHistoryTokens(input.query))]
  const matches = tokens.length && indexedStores.has(store)
    ? store.db.prepare(TURN(`${ftsTable} JOIN project_conversation_search_key entry ON entry.id = ${ftsTable}.rowid
      JOIN kv run ON run.key = entry.run_key`) + ` ${range}
      AND ${ftsTable} MATCH ? ORDER BY ${ftsTable}.rank, ${AT} DESC, run.key DESC LIMIT 5`)
      .all(scope.projectId, scope.channel.source, scope.channel.thread, ...params, tokens.map(token => `"${token}"`).join(' AND ')) as unknown as Turn[]
    : []
  if (matches.length < 5) {
    const literal = turns(store, scope, ` ${range}
      AND (instr(lower(${MESSAGE} ->> '$.text'), lower(?)) > 0 OR instr(lower(reply.value ->> '$.text'), lower(?)) > 0)
      ORDER BY ${AT} DESC, run.key DESC LIMIT 5`, ...params, input.query, input.query)
    const seen = new Set(matches.map(turn => turn.id))
    matches.push(...literal.filter(turn => !seen.has(turn.id)).slice(0, 5 - matches.length))
  }
  const query = input.query.toLowerCase()
  const terms = tokens.map(token => token.toLowerCase())
  return matches.map(turn => {
    const message = turn.text.toLowerCase(), reply = turn.reply?.toLowerCase() ?? ''
    const inReply = !message.includes(query) && (reply.includes(query)
      || terms.filter(term => reply.includes(term)).length > terms.filter(term => message.includes(term)).length)
    const text = inReply ? turn.reply! : turn.text
    const lower = inReply ? reply : message
    const offset = lower.indexOf(query)
    return { ...reference(turn), excerpt: excerpt(text, offset >= 0 ? offset : lower.indexOf(terms.find(term => lower.includes(term)) ?? '')),
      matches: inReply ? 'reply' : 'message' }
  })
}

/** Resolve one exact reference using the same project and conversation boundary as history reads. */
export function findConversationTurn(store: Store, scope: Scope, id: string) {
  return turns(store, scope, ` AND (run.key = ? OR ${MESSAGE} ->> '$.messageId' = ? OR ${NATIVE} = ?)
    ORDER BY (run.key = ?) DESC, ${AT} DESC LIMIT 1`, KV.projects.agentRun(id), id, id, KV.projects.agentRun(id))[0]
}

export function readConversation(store: Store, scope: Scope, id: string, offset: number) {
  const turn = findConversationTurn(store, scope, id)
  if (!turn) return undefined
  const end = offset + pageSize
  const replies = !offset && turn.nativeId ? turns(store, scope, ` AND ${PARENT} = ?
    AND run.key != ? ORDER BY ${AT}, run.key LIMIT 3`, turn.nativeId, KV.projects.agentRun(turn.id)) : []
  return { ...reference(turn), text: turn.text.slice(offset, end), nextOffset: end < turn.text.length ? end : null,
    ...(!offset ? { reply: turn.reply?.slice(0, 1800) ?? null, replies: replies.map(item => ({ ...reference(item), excerpt: excerpt(item.text) })) } : {}) }
}

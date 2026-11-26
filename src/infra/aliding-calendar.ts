import { execFile } from 'node:child_process'
import { constants, accessSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { CalendarExecutor, CalendarReceipt, CalendarRequest } from '../app/project-calendar.ts'

const absolute = z.string().refine(isAbsolute)
const Config = z.strictObject({
  python: absolute, skillDirectory: absolute, envFile: absolute,
  corpId: z.string().min(1), organizers: z.array(z.string().min(1)).min(1),
})
const time = z.string().refine(value => Number.isFinite(Date.parse(value)))
const Receipt = z.object({
  phase: z.string().optional(), verified: z.boolean().optional(), ok: z.boolean().optional(),
  event_id: z.string().regex(/^[\w+=./:@-]{1,256}$/).optional(), room_code: z.string().regex(/^[0-9 -]{4,40}$/).nullish(),
  summary: z.string().max(500).nullish(), start: time.nullish(), end: time.nullish(), event_status: z.string().max(64).nullish(),
  accepted: z.boolean().optional(), deleted: z.boolean().optional(), success: z.boolean().optional(),
  error_code: z.string().optional(),
})

/** Runs only the administrator-selected skill entry point. Credentials remain in its local environment file. */
export function alidingCalendar(raw: string | undefined, stateDir: string, actionsScript: string): CalendarExecutor | undefined {
  if (!raw?.trim()) return
  let config: z.output<typeof Config>
  try {
    config = Config.parse(JSON.parse(raw))
    accessSync(config.python, constants.X_OK)
    accessSync(config.envFile, constants.R_OK)
    accessSync(join(config.skillDirectory, 'scripts', 'create_event.py'), constants.R_OK)
  } catch {
    throw new Error('Set SUPERAGENT_DINGTALK_CALENDAR to valid calendar paths, corporation and organizers')
  }
  const skills = join(config.skillDirectory, 'scripts')
  const script = join(skills, 'create_event.py')
  const receipts = join(stateDir, 'calendar-receipts')
  const resultPath = (id: string) => join(receipts, `${id}.json`)
  const receipt = async (id: string, request?: CalendarRequest): Promise<CalendarReceipt> => {
    try {
      const saved = Receipt.parse(JSON.parse(await readFile(resultPath(id), 'utf8')))
      if (request?.action) {
        const { eventId, kind } = request.action
        if (saved.event_id !== eventId) return { state: 'uncertain' }
        if (saved.ok && saved.verified) return { state: 'confirmed', eventId, snapshot: {
          title: saved.summary ?? '', start: saved.start ?? undefined, end: saved.end ?? undefined,
          roomCode: saved.room_code ?? undefined, status: saved.event_status ?? undefined,
        } }
        if (saved.accepted || saved.deleted || kind === 'invite' && saved.success) return { state: 'accepted', eventId }
        if (saved.phase === 'GetEventBeforeAction' || saved.phase === 'GetEventBeforeDelete')
          return { state: 'rejected' }
      }
      if (saved.ok && saved.verified && saved.event_id && saved.room_code)
        return { state: 'verified', eventId: saved.event_id, roomCode: saved.room_code }
      if (!request?.action && saved.event_id) return { state: 'created', eventId: saved.event_id }
      if (saved.phase === 'load_credentials' || saved.error_code === 'security.apiUnauthorized.error') return { state: 'rejected' }
    } catch { /* An interrupted write or missing receipt cannot prove the calendar was unchanged. */ }
    return { state: 'uncertain' }
  }
  const execute = async (id: string, request: CalendarRequest, entry: string, flags: string[], signal: AbortSignal) => {
    await mkdir(receipts, { recursive: true, mode: 0o700 })
    const args = ['-B', '-E', '-s', entry, `--env-file=${config.envFile}`, `--result=${resultPath(id)}`,
      `--account-id=${request.organizer}`, '--execute', ...flags,
      ...request.attendees.map(attendee => `--attendee-id=${attendee}`)]
    await new Promise<void>(resolve => {
      execFile(config.python, args, { signal, timeout: request.action ? 160_000 : 70_000, maxBuffer: 64_000,
        env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', SUPERAGENT_ALIDING_SKILL_SCRIPTS: skills } }, () => resolve())
    })
    return receipt(id, request)
  }
  return {
    corpId: config.corpId, organizers: config.organizers, receipt,
    create(id, request, signal) {
      const { title, start, end } = request.event!
      return execute(id, request, script, [`--title=${title}`, `--start=${start}`, `--end=${end}`], signal)
    },
    manage(id, request, signal) {
      const { action } = request
      const flags = [`--action=${action.kind}`, `--event-id=${action.eventId}`]
      if (action.kind === 'update') for (const name of ['title', 'description', 'start', 'end'] as const) {
        const value = action[name]
        if (value !== undefined) flags.push(`--${name}=${value}`)
      }
      return execute(id, request, actionsScript, flags, signal)
    },
  }
}

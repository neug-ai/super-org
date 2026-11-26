import { execFile } from 'node:child_process'
import { constants, accessSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { CalendarExecutor, CalendarReceipt } from '../app/project-calendar.ts'

const absolute = z.string().refine(isAbsolute)
const Config = z.strictObject({
  python: absolute, skillDirectory: absolute, envFile: absolute,
  corpId: z.string().min(1), organizers: z.array(z.string().min(1)).min(1),
})
const Receipt = z.object({
  phase: z.string().optional(), verified: z.boolean().optional(), ok: z.boolean().optional(),
  event_id: z.string().regex(/^[\w+=./:@-]{1,256}$/).optional(), room_code: z.string().regex(/^[0-9 -]{4,40}$/).optional(),
  error_code: z.string().optional(),
})

/** Runs only the administrator-selected skill entry point. Credentials remain in its local environment file. */
export function alidingCalendar(raw: string | undefined, stateDir: string): CalendarExecutor | undefined {
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
  const script = join(config.skillDirectory, 'scripts', 'create_event.py')
  const receipts = join(stateDir, 'calendar-receipts')
  const resultPath = (id: string) => join(receipts, `${id}.json`)
  const receipt = async (id: string): Promise<CalendarReceipt> => {
    try {
      const saved = Receipt.parse(JSON.parse(await readFile(resultPath(id), 'utf8')))
      if (saved.ok && saved.verified && saved.event_id && saved.room_code)
        return { state: 'verified', eventId: saved.event_id, roomCode: saved.room_code }
      if (saved.event_id) return { state: 'created', eventId: saved.event_id }
      if (saved.phase === 'load_credentials' || saved.error_code === 'security.apiUnauthorized.error') return { state: 'rejected' }
    } catch { /* An interrupted write or missing receipt cannot prove the calendar was unchanged. */ }
    return { state: 'uncertain' }
  }
  return {
    corpId: config.corpId, organizers: config.organizers, receipt,
    async create(id, request, signal) {
      await mkdir(receipts, { recursive: true, mode: 0o700 })
      const { title, start, end } = request.event
      const args = ['-B', '-E', '-s', script, `--env-file=${config.envFile}`, `--result=${resultPath(id)}`,
        `--account-id=${request.organizer}`, `--title=${title}`, `--start=${start}`, `--end=${end}`, '--execute',
        ...request.attendees.map(attendee => `--attendee-id=${attendee}`)]
      await new Promise<void>(resolve => {
        execFile(config.python, args, { signal, timeout: 70_000, maxBuffer: 64_000,
          env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' } }, () => resolve())
      })
      return receipt(id)
    },
  }
}

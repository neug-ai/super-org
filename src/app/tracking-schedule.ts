import { z } from 'zod'

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const day = 86_400_000
const minute = 60_000

const timeZone = z.string().trim().min(1).max(100).refine(zone => {
  try { return !/^[+-]/.test(zone) && !!new Intl.DateTimeFormat('en', { timeZone: zone }) }
  catch { return false }
}, 'Use an IANA time zone, such as Asia/Shanghai')

export const TrackingSchedule = z.strictObject({
  timeZone,
  times: z.array(time).min(1).max(6).transform(times => [...new Set(times)].sort()),
  workHours: z.strictObject({ start: time, end: time }).default({ start: '09:00', end: '18:00' }),
}).refine(({ times, workHours }) => workHours.start < workHours.end && times.every(at => at >= workHours.start && at < workHours.end),
  'Check times must fall within project working hours')
export type TrackingSchedule = z.output<typeof TrackingSchedule>

function calendar(timeZone: string) {
  const format = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return (at: number) => {
    const parts = Object.fromEntries(format.formatToParts(at).map(({ type, value }) => [type, value]))
    const date = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
    return { date, time: `${parts.hour}:${parts.minute}`, wallTime: date + (Number(parts.hour) * 60 + Number(parts.minute)) * minute }
  }
}

const weekday = (date: number) => new Date(date).getUTCDay() % 6 !== 0

export function inWorkingHours(schedule: TrackingSchedule, at: number): boolean {
  const local = calendar(schedule.timeZone)(at)
  return weekday(local.date) && local.time >= schedule.workHours.start && local.time < schedule.workHours.end
}

/** Find the nearest slots using local calendar dates. Skip nonexistent DST minutes and use the first occurrence of repeated minutes. */
export function trackingSlots(schedule: TrackingSchedule, now: number): { latest: number; next: number } {
  const local = calendar(schedule.timeZone)
  const today = local(now).date
  let latest = -Infinity, next = Infinity
  for (let offset = 0; offset <= 7 && (!Number.isFinite(latest) || !Number.isFinite(next)); offset++) {
    for (const date of offset ? [today - offset * day, today + offset * day] : [today]) {
      if (!weekday(date)) continue
      const offsets = new Set([date - day, date, date + day].map(at => local(at).wallTime - at))
      for (const time of schedule.times) {
        const [hour, minutes] = time.split(':').map(Number)
        const target = date + (hour! * 60 + minutes!) * minute
        const slot = Math.min(...[...offsets].map(delta => target - delta).filter(at => local(at).wallTime === target))
        if (!Number.isFinite(slot)) continue
        if (slot <= now) latest = Math.max(latest, slot)
        else next = Math.min(next, slot)
      }
    }
  }
  return { latest, next }
}

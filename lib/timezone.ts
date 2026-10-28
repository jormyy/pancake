export const DEFAULT_LEAGUE_TIMEZONE = 'America/Los_Angeles'

export function resolveLeagueTimezone(timezone?: string | null): string {
  if (!timezone) return DEFAULT_LEAGUE_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return timezone
  } catch {
    return DEFAULT_LEAGUE_TIMEZONE
  }
}

function formatLeagueDateTime(
  value: string | number | Date,
  timezone: string = DEFAULT_LEAGUE_TIMEZONE,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: resolveLeagueTimezone(timezone) }).format(date)
}

export function formatLeagueDate(value: string | number | Date, timezone: string = DEFAULT_LEAGUE_TIMEZONE): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return 'unknown'
    return formatLeagueDateTime(date, 'UTC', { year: 'numeric', month: 'short', day: 'numeric' })
  }
  return formatLeagueDateTime(value, timezone, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatLeagueTime(value: string | number | Date, timezone: string = DEFAULT_LEAGUE_TIMEZONE): string {
  return formatLeagueDateTime(value, timezone, { hour: 'numeric', minute: '2-digit' })
}

export function todayLeague(timezone?: string | null, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveLeagueTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find(value => value.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function endOfLeagueDayUTC(day: string, timezone?: string | null): string {
  const next = new Date(`${day}T00:00:00Z`).getTime() + 86_400_000
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveLeagueTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  let midnight = next
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(midnight)
    const part = (type: string) => parts.find(value => value.type === type)!.value
    const local = Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`)
    midnight += next - local
  }
  return new Date(midnight - 1).toISOString()
}

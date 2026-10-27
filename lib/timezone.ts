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

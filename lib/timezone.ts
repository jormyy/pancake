export const DEFAULT_LEAGUE_TIMEZONE = 'America/Los_Angeles'

const resolvedZones = new Map<string, string>()

export function resolveLeagueTimezone(timezone?: string | null): string {
  if (!timezone) return DEFAULT_LEAGUE_TIMEZONE
  const cached = resolvedZones.get(timezone)
  if (cached) return cached
  let resolved = DEFAULT_LEAGUE_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    resolved = timezone
  } catch {
    resolved = DEFAULT_LEAGUE_TIMEZONE
  }
  resolvedZones.set(timezone, resolved)
  return resolved
}

export function formatLeagueDateTime(
  value: string | number | Date,
  timezone: string = DEFAULT_LEAGUE_TIMEZONE,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  const zone = resolveLeagueTimezone(timezone)
  const formatted = optionFormatter(zone, options).format(date)
  return options.hour || options.timeStyle ? `${formatted} ${leagueTimezoneLabel(zone, date)}` : formatted
}

export function formatLeagueDate(value: string | number | Date, timezone: string = DEFAULT_LEAGUE_TIMEZONE): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return 'unknown'
    return cachedFormatter('date-utc', 'UTC', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
  }
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  return cachedFormatter('date', resolveLeagueTimezone(timezone), { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

export function formatLeagueTime(value: string | number | Date, timezone: string = DEFAULT_LEAGUE_TIMEZONE): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  const zone = resolveLeagueTimezone(timezone)
  return `${cachedFormatter('time', zone, { hour: 'numeric', minute: '2-digit' }).format(date)} ${leagueTimezoneLabel(zone, date)}`
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function optionFormatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}:${JSON.stringify(options)}`
  let formatter = formatterCache.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone })
    formatterCache.set(key, formatter)
  }
  return formatter
}

function cachedFormatter(kind: string, timezone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${kind}:${timezone}`
  let formatter = formatterCache.get(key)
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }); formatterCache.set(key, formatter) }
  return formatter
}

/** "7:00 PM" in the league's timezone, without the zone label, for tight rows where every time shares it. */
export function formatLeagueClock(value: string | number | Date, timezone: string = DEFAULT_LEAGUE_TIMEZONE): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  return cachedFormatter('clock', resolveLeagueTimezone(timezone), { hour: 'numeric', minute: '2-digit' }).format(date)
}

export function todayLeague(timezone?: string | null, now: Date = new Date()): string {
  const parts = cachedFormatter('day', resolveLeagueTimezone(timezone), {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find(value => value.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function endOfLeagueDayUTC(day: string, timezone?: string | null): string {
  const next = new Date(`${day}T00:00:00Z`).getTime() + 86_400_000
  const formatter = cachedFormatter('endday', resolveLeagueTimezone(timezone), {
    year: 'numeric', month: '2-digit', day: '2-digit',
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

export function leagueTimezoneLabel(timezone?: string | null, now: Date = new Date()): string {
  const zone = resolveLeagueTimezone(timezone)
  const label = cachedFormatter(`label:generic`, zone, { timeZoneName: 'shortGeneric' })
    .formatToParts(now).find(part => part.type === 'timeZoneName')?.value
  if (label && !label.includes(' ')) return label
  return cachedFormatter(`label:short`, zone, { timeZoneName: 'short' })
    .formatToParts(now).find(part => part.type === 'timeZoneName')?.value ?? zone
}

export function startOfLeagueDayUTC(day: string, timezone?: string | null): Date {
  const previous = new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  return new Date(Date.parse(endOfLeagueDayUTC(previous, timezone)) + 1)
}

export function leagueDateTimeInput(value: Date, timezone?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveLeagueTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value)
  const part = (type: string) => parts.find(value => value.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

export function parseLeagueDateTime(value: string, timezone?: string | null): Date | null {
  const normalized = value.trim().replace('T', ' ')
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) return null
  const target = Date.parse(`${normalized.replace(' ', 'T')}:00Z`)
  if (!Number.isFinite(target)) return null
  const [day, time] = normalized.split(' ')
  const [hour, minute] = time.split(':').map(Number)
  let result = new Date(startOfLeagueDayUTC(day, timezone).getTime() + (hour * 60 + minute) * 60_000)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const displayed = leagueDateTimeInput(result, timezone)
    if (displayed === normalized) return result
    const local = Date.parse(`${displayed.replace(' ', 'T')}:00Z`)
    result = new Date(result.getTime() + target - local)
  }
  return null
}

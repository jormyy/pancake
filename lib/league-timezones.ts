import { onSessionCachesCleared } from '@/lib/session-cache-registry'
import { resolveLeagueTimezone } from '@/lib/timezone'

const timezones = new Map<string, string>()

export function rememberLeagueTimezone(leagueId: string, timezone?: string | null): void {
    timezones.set(leagueId, resolveLeagueTimezone(timezone))
}

export function leagueTimezone(leagueId?: string | null): string {
    return resolveLeagueTimezone(leagueId ? timezones.get(leagueId) : undefined)
}

onSessionCachesCleared(() => timezones.clear())

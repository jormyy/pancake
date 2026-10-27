import { sessionOwner } from '@/lib/session-cache-registry'
import type { ScreenName, ScreenScope } from '@/lib/cache/screen-cache'
import { todayET } from '@/lib/shared/dates'

export function screenScope(screen: ScreenName, leagueId?: string | null, memberId?: string | null, params: Record<string, unknown> = {}, accountId = sessionOwner()): ScreenScope {
    if (!accountId) throw new Error('Sign in to open this screen.')
    return { screen, accountId, leagueId, memberId, seasonId: typeof params.seasonId === 'string' ? params.seasonId : null, params: { date: todayET(), ...params } }
}

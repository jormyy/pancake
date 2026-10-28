import { useMemo } from 'react'
import type { NBAGameRow } from '@/lib/games'
import { resolveLeagueTimezone } from '@/lib/timezone'

export function useMatchupGameTimes(games: readonly NBAGameRow[], timezone?: string) {
    return useMemo(() => ({
        values: new Map(games.map(game => [game.id, game.game_time ?? null])),
        timezone: resolveLeagueTimezone(timezone),
    }), [games, timezone])
}

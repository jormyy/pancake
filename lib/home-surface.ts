import type { LiveStatLine, NBAGameRow } from '@/lib/games'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

// Which surface the Home play area shows. Kept pure so the precedence is
// testable: a loaded matchup, then the live-draft card (the manager must get
// to the draft room even when the matchup refresh failed), then loading, then
// a failed load. A confirmed empty answer also survives a background read.
type HomeSurface = 'draft' | 'matchup' | 'loading' | 'error' | 'empty'

export function resolveHomeSurface(input: {
    leagueStatus: string | null | undefined
    hasMatchup: boolean
    emptyConfirmed: boolean
    loading: boolean
    error: string | null | undefined
}): HomeSurface {
    if (input.hasMatchup) return 'matchup'
    if (input.leagueStatus === 'drafting') return 'draft'
    if (input.emptyConfirmed) return 'empty'
    if (input.loading) return 'loading'
    if (input.error) return 'error'
    return 'loading'
}


export function getGameDisplayState(
    games: readonly { home_team: string; away_team: string; status: string }[],
    freshness: 'fresh' | 'refreshing' | 'failed' | 'offline',
) {
    return {
        ready: freshness !== 'refreshing' || games.length > 0,
        liveTeams: new Set(freshness === 'failed' || freshness === 'offline' ? [] : games
            .filter(game => game.status === 'InProgress')
            .flatMap(game => [game.home_team, game.away_team])),
    }
}


type GameDisplay = {
    todaysGames: NBAGameRow[]
    liveStats: Map<string, LiveStatLine>
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
}
type SavedGameDisplay = {
    date: string
    players: string
    savedAt: number
    games: NBAGameRow[]
    stats: [string, LiveStatLine][]
    started: string[]
    matchups: [string, { opponent: string; isHome: boolean }][]
}

export function readHomeGameDisplay(scope: string, date: string, players: string): GameDisplay | null {
    const saved = readPersistentCache<SavedGameDisplay>(`pancake:home-matchup:games:v1:${scope}`)
    const age = saved ? Date.now() - saved.savedAt : Infinity
    if (!saved || saved.date !== date || saved.players !== players || !Number.isFinite(age) || age < 0 || age > 60_000) return null
    if (!Array.isArray(saved.games) || !saved.games.length || !Array.isArray(saved.stats) || !Array.isArray(saved.started) || !Array.isArray(saved.matchups)) return null
    return { todaysGames: saved.games, liveStats: new Map(saved.stats), startedTeams: new Set(saved.started), teamMatchups: new Map(saved.matchups) }
}

export function saveHomeGameDisplay(scope: string, date: string, players: string, display: GameDisplay) {
    if (!display.todaysGames.length) return
    writePersistentCache<SavedGameDisplay>(`pancake:home-matchup:games:v1:${scope}`, {
        date, players, savedAt: Date.now(), games: display.todaysGames,
        stats: [...display.liveStats], started: [...display.startedTeams], matchups: [...display.teamMatchups],
    })
}

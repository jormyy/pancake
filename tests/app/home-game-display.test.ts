import { beforeEach, expect, it, vi } from 'vitest'
import { readHomeGameDisplay, saveHomeGameDisplay } from '@/lib/home-surface'
import { clearPersistentCaches, readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

const display = {
    todaysGames: [{ id: 'game', nba_game_id: '0022700001', game_date: '2026-10-24', home_team: 'DEN', away_team: 'LAL', home_score: 10, away_score: 9, status: 'InProgress', game_status_text: 'Q1' }],
    liveStats: new Map(), startedTeams: new Set(['DEN', 'LAL']), teamMatchups: new Map([['DEN', { opponent: 'LAL', isHome: true }]]),
}
beforeEach(() => { clearPersistentCaches(); setSessionOwner('owner') })

it('keeps all four league snapshots when live games refresh', () => {
    for (let league = 1; league <= 4; league++) writePersistentCache(`pancake:home-matchup:v1:league-${league}`, { league })
    saveHomeGameDisplay('owner:league-1:member', '2026-10-24', 'players', display)
    for (let league = 1; league <= 4; league++) expect(readPersistentCache(`pancake:home-matchup:v1:league-${league}`)).toEqual({ league })
    expect(readHomeGameDisplay('owner:league-1:member', '2026-10-24', 'players')).toEqual(display)
    expect(readPersistentCache('pancake:home-matchup:games:v1:owner:league-1:member')).toBeNull()
})

it('clears live displays with session caches', () => {
    saveHomeGameDisplay('owner:league:member', '2026-10-24', 'players', display)
    clearSessionCaches()
    expect(readHomeGameDisplay('owner:league:member', '2026-10-24', 'players')).toBeNull()
})

it('expires a live display after sixty seconds', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
        saveHomeGameDisplay('owner:league:member', '2026-10-24', 'players', display)
        clock.mockReturnValue(61000)
        expect(readHomeGameDisplay('owner:league:member', '2026-10-24', 'players')).toEqual(display)
        clock.mockReturnValue(61001)
        expect(readHomeGameDisplay('owner:league:member', '2026-10-24', 'players')).toBeNull()
    } finally { clock.mockRestore() }
})

it('does not repopulate live displays after sign-out', () => {
    setSessionOwner(null)
    saveHomeGameDisplay('owner:league:member', '2026-10-24', 'players', display)
    expect(readHomeGameDisplay('owner:league:member', '2026-10-24', 'players')).toBeNull()
})

import { describe, expect, it, vi } from 'vitest'
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
import { getGameDisplayState, readHomeGameDisplay, resolveHomeSurface, saveHomeGameDisplay } from '@/lib/home-surface'

// Review S4: the live-draft card must win over a failed refresh, and a failed
// refresh must never be shown as "no matchup".
describe('resolveHomeSurface', () => {
    const base = { leagueStatus: 'active', hasMatchup: false, loading: false, error: null, emptyConfirmed: true }

    it('shows the matchup whenever one is loaded, even with a stale error', () => {
        expect(resolveHomeSurface({ ...base, hasMatchup: true, error: 'Failed to load matchup' })).toBe('matchup')
    })

    it('keeps the live-draft card ahead of loading and error', () => {
        expect(resolveHomeSurface({ ...base, leagueStatus: 'drafting', loading: true })).toBe('draft')
        expect(resolveHomeSurface({ ...base, leagueStatus: 'drafting', error: 'Failed to load matchup' })).toBe('draft')
    })

    it('renders a failed load as an error, never as an empty week', () => {
        expect(resolveHomeSurface({ ...base, emptyConfirmed: false, error: 'Failed to load matchup' })).toBe('error')
        expect(resolveHomeSurface({ ...base, emptyConfirmed: false, loading: true, error: 'Failed to load matchup' })).toBe('loading')
    })

    it('shows a settled empty week', () => {
        expect(resolveHomeSurface(base)).toBe('empty')
        expect(resolveHomeSurface({ ...base, leagueStatus: undefined })).toBe('empty')
    })
    it('retains a confirmed empty answer during revalidation and errors', () => {
        expect(resolveHomeSurface({ ...base, loading: true })).toBe('empty')
        expect(resolveHomeSurface({ ...base, error: 'Refresh failed' })).toBe('empty')
    })
    it('keeps an unconfirmed cached or stale-membership empty result blank', () => {
        expect(resolveHomeSurface({ ...base, emptyConfirmed: false })).toBe('loading')
        expect(resolveHomeSurface({ ...base, emptyConfirmed: false, error: 'Failed to load matchup' })).toBe('error')
        expect(resolveHomeSurface({ ...base, emptyConfirmed: false, hasMatchup: true })).toBe('matchup')
    })

})

const games = [{ home_team: 'DEN', away_team: 'LAL', status: 'InProgress' }]

it('waits for the initial game read before showing game labels', () => {
    expect(getGameDisplayState([], 'refreshing').ready).toBe(false)
    expect(getGameDisplayState([], 'fresh').ready).toBe(true)
    expect(getGameDisplayState([], 'failed').ready).toBe(true)
    expect(getGameDisplayState([], 'offline').ready).toBe(true)
})

it('keeps live labels during a refresh and clears them on failed or offline reads', () => {
    expect(getGameDisplayState(games, 'fresh').liveTeams).toEqual(new Set(['DEN', 'LAL']))
    expect(getGameDisplayState(games, 'refreshing')).toEqual(getGameDisplayState(games, 'fresh'))
    expect(getGameDisplayState(games, 'failed').liveTeams.size).toBe(0)
    expect(getGameDisplayState(games, 'offline').liveTeams.size).toBe(0)
    expect(getGameDisplayState([{ ...games[0], status: 'Final' }], 'fresh').liveTeams.size).toBe(0)
})


it('reuses a complete game display only for the same owner, date, players, and read window', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const display = {
        todaysGames: [{ id: 'game', nba_game_id: '0022700001', game_date: '2026-10-24', home_team: 'DEN', away_team: 'LAL', home_score: 10, away_score: 9, status: 'InProgress', game_status_text: 'Q1' }],
        liveStats: new Map(), startedTeams: new Set(['DEN', 'LAL']), teamMatchups: new Map([['DEN', { opponent: 'LAL', isHome: true }]]),
    }
    saveHomeGameDisplay('owner:league:member:season:matchup', '2026-10-24', '["player"]', display)
    expect(readHomeGameDisplay('owner:league:member:season:matchup', '2026-10-24', '["player"]')).toEqual(display)
    expect(readHomeGameDisplay('other-owner:league:member:season:matchup', '2026-10-24', '["player"]')).toBeNull()
    expect(readHomeGameDisplay('owner:league:member:season:matchup', '2026-10-25', '["player"]')).toBeNull()
    expect(readHomeGameDisplay('owner:league:member:season:matchup', '2026-10-24', '["other-player"]')).toBeNull()
    clock.mockReturnValue(61_001)
    expect(readHomeGameDisplay('owner:league:member:season:matchup', '2026-10-24', '["player"]')).toBeNull()
    clock.mockRestore()
})

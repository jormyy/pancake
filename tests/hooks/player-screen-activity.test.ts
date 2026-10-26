import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { seasonLine } from '@/tests/components/player/season-fixtures'

const state = vi.hoisted(() => ({ focused: true, player: vi.fn(), seasons: vi.fn(), lines: vi.fn(), scoring: vi.fn(), transactions: vi.fn(), projection: vi.fn(), write: vi.fn() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => state.focused }))
vi.mock('@/lib/players', () => ({ getPlayerSeasonAverages: () => new Promise(() => {}), getPlayerAverageFantasyPoints: async () => null, getPlayer: state.player, getAvailableSeasons: state.seasons, getPlayerTransactionHistory: state.transactions }))
vi.mock('@/components/player/season-data', async importOriginal => ({ ...await importOriginal<typeof import('@/components/player/season-data')>(), getPlayerSeasonLines: state.lines, getPlayerScoringSettings: state.scoring }))
vi.mock('@/lib/projections', () => ({ getPlayerProjection: state.projection }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => undefined, writePersistentCache: state.write }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-23' }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let hidden: boolean
let online: boolean
let doc: EventTarget
let events: EventTarget
let renderer: ReactTestRenderer | undefined
let latest: ReturnType<typeof usePlayerScreenData>
const Probe = ({ owner = 'actor', authorized = true }: { owner?: string; authorized?: boolean }) => {
    latest = usePlayerScreenData('player', 'league', { ownerKey: owner, authorized, scoringSettings: { points: 1, assists: 2 } })
    return null
}
const reads = () => [state.player, state.seasons, state.lines, state.transactions, state.projection].map(read => read.mock.calls.length)
const changeVisibility = async (value: boolean) => { hidden = value; await act(async () => { doc.dispatchEvent(new Event('visibilitychange')) }) }
beforeEach(() => {
    vi.clearAllMocks()
    state.focused = true
    hidden = false
    online = true
    doc = new EventTarget()
    events = new EventTarget()
    Object.defineProperty(doc, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', events)
    vi.stubGlobal('navigator', { get onLine() { return online } })
    state.player.mockResolvedValue({ id: 'player', display_name: 'Current', nba_team: 'LAL' })
    state.seasons.mockResolvedValue([2026, 2025])
    state.lines.mockResolvedValue([seasonLine()])
    state.scoring.mockResolvedValue({ points: 1, assists: 2 })
    state.transactions.mockResolvedValue([])
    state.projection.mockResolvedValue(null)
})
afterEach(async () => { await act(async () => { renderer?.unmount() }); renderer = undefined; vi.unstubAllGlobals(); vi.useRealTimers() })

it('defers hidden or offline loaders and catches up only the current player', async () => {
    hidden = true
    online = false
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(reads()).toEqual(Array(5).fill(0))
    await changeVisibility(false)
    expect(reads()).toEqual(Array(5).fill(0))
    online = true
    await act(async () => { events.dispatchEvent(new Event('online')) })
    expect(reads()).toEqual(Array(5).fill(1))
    expect(latest.player?.display_name).toBe('Current')
})

it('fences late responses and never reloads an inactive route', async () => {
    let release!: (player: { id: string; display_name: string; nba_team: string }) => void
    state.player.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await changeVisibility(true)
    await act(async () => { release({ id: 'player', display_name: 'Late', nba_team: 'LAL' }) })
    expect(latest.player).toBeNull()
    state.focused = false
    await act(async () => { renderer!.update(React.createElement(Probe)) })
    await changeVisibility(false)
    expect(state.player).toHaveBeenCalledTimes(1)
    state.focused = true
    await act(async () => { renderer!.update(React.createElement(Probe)) })
    expect(state.player).toHaveBeenCalledTimes(2)
    expect(latest.player?.display_name).toBe('Current')
})

it('pages the downloaded season locally and keeps the season across suspension', async () => {
    state.lines.mockResolvedValue(Array.from({ length: 31 }, (_, index) => seasonLine({ id: `stat-${index}` })))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(latest.gameLog).toHaveLength(15)
    expect(latest.seasonAverages?.gamesPlayed).toBe(31)
    const before = reads()
    await act(async () => { await latest.loadMoreGames() })
    expect(latest.gameLog).toHaveLength(30)
    await act(async () => { await latest.loadMoreGames() })
    expect(latest.gameLog).toHaveLength(31)
    expect(latest.hasMoreGames).toBe(false)
    expect(reads()).toEqual(before)
    await act(async () => { latest.handleSeasonSelect(2025) })
    await changeVisibility(true)
    await changeVisibility(false)
    expect(latest.selectedSeason).toBe(2025)
    await act(async () => { renderer!.update(React.createElement(Probe, { authorized: false })) })
    const suspended = reads()
    await changeVisibility(true)
    await changeVisibility(false)
    expect(reads()).toEqual(suspended)
    await act(async () => { renderer!.update(React.createElement(Probe, { owner: 'next', authorized: false })) })
    expect(latest.player).toBeNull()
    expect(latest.seasonAverages).toBeNull()
})

it('starts all cards before the player or change stream settles', async () => {
    vi.useFakeTimers()
    Object.defineProperty(events, 'WebSocket', { value: function WebSocket() {} })
    setLeagueChangesConnected('league', false)
    state.player.mockReturnValueOnce(new Promise(() => {}))
    state.projection.mockReturnValueOnce(new Promise(() => {}))
    state.transactions.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(reads()).toEqual(Array(5).fill(1))
    expect(latest.player).toBeNull()
    expect(latest.seasonAverages?.avgPoints).toBe(24)
    expect(latest.seasonLoading).toBe(false)
    expect(latest.projectionSettled).toBe(false)
    expect(latest.transactionsSettled).toBe(false)
})

it('keeps numbers in place and lets an in-flight read finish before one catch-up', async () => {
    vi.useFakeTimers()
    await act(async () => { renderer = create(React.createElement(Probe)) })
    let release!: (lines: ReturnType<typeof seasonLine>[]) => void
    state.lines.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const notify = async () => { await act(async () => { notifyLeagueChange('league', { topic: 'stat', scopes: null }); await vi.advanceTimersByTimeAsync(250) }) }
    await notify()
    expect(latest.seasonLoading).toBe(false)
    expect(latest.seasonAverages?.avgPoints).toBe(24)
    await notify()
    await notify()
    expect(state.lines).toHaveBeenCalledTimes(2)
    expect(state.player).toHaveBeenCalledOnce()
    expect(latest.rosterRevision).toBe(0)
    state.lines.mockResolvedValue([seasonLine({ points: 32 })])
    await act(async () => { release([seasonLine({ points: 30 })]) })
    expect(state.lines).toHaveBeenCalledTimes(3)
    expect(latest.seasonAverages?.avgPoints).toBe(32)
})

it('separates roster signals from projection and average changes', async () => {
    vi.useFakeTimers()
    await act(async () => { renderer = create(React.createElement(Probe)) })
    for (const resource of ['projections', 'averages'] as const) {
        await act(async () => {
            notifyLeagueChange('league', { topic: 'resources', scopes: null, details: [{ resource, season_id: 'season' }] })
            await vi.advanceTimersByTimeAsync(250)
        })
    }
    expect(latest.rosterRevision).toBe(0)
    await act(async () => { notifyLeagueChange('league', { topic: 'roster', scopes: null }); await vi.advanceTimersByTimeAsync(250) })
    expect(latest.rosterRevision).toBe(1)
})

it('keeps public player data available without private scoring or history', async () => {
    const Public = () => { latest = usePlayerScreenData('player', null); return null }
    await act(async () => { renderer = create(React.createElement(Public)) })
    expect(reads()).toEqual([1, 1, 1, 0, 0])
    expect(latest.seasonAverages?.avgPoints).toBe(24)
    expect(latest.fantasyPointsMap).toBeNull()
    expect(latest.transactions).toEqual([])
})

it('keeps the prior season and expanded log visible until the selected season arrives', async () => {
    state.lines.mockResolvedValueOnce(Array.from({ length: 31 }, (_, index) => seasonLine({ id: `current-${index}` })))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { await latest.loadMoreGames(); await latest.loadMoreGames() })
    const previousGames = latest.gameLog
    const previousAverage = latest.seasonAverages
    let release!: (rows: ReturnType<typeof seasonLine>[]) => void
    state.lines.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await act(async () => { latest.handleSeasonSelect(2025) })
    expect(latest.seasonLoading).toBe(true)
    expect(latest.selectedSeason).toBe(2025)
    expect(latest.gameLog).toEqual(previousGames)
    expect(latest.seasonAverages).toEqual(previousAverage)
    expect(state.write.mock.calls.at(-1)?.[1].seasons.some(([year]: [number]) => year === 2025)).toBe(false)
    await act(async () => { release([seasonLine({ id: 'past', points: 10 })]) })
    expect(latest.seasonLoading).toBe(false)
    expect(latest.gameLog.map(game => game.gameId)).toEqual(['past'])
    expect(latest.seasonAverages?.avgPoints).toBe(10)
})

it('uses the known scoring rules without another read until a scoring change arrives', async () => {
    vi.useFakeTimers()
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(state.scoring).not.toHaveBeenCalled()
    expect(latest.initialSettled).toBe(true)
    state.scoring.mockResolvedValue({ points: 2 })
    await act(async () => {
        notifyLeagueChange('league', { topic: 'resources', scopes: null, details: [{ resource: 'scoring', season_id: 'season' }] })
        await vi.advanceTimersByTimeAsync(250)
    })
    expect(state.scoring).toHaveBeenCalledOnce()
    expect(latest.avgFantasyPoints).toBe(48)
})

it('starts reads in the first focused render and waits for every initial resource', async () => {
    let firstEpoch: string | undefined
    let requestedEpoch: string | undefined
    let release!: (value: null) => void
    state.player.mockImplementation(async () => {
        requestedEpoch = latest.readEpoch
        return { id: 'player', display_name: 'Current', nba_team: 'LAL' }
    })
    state.projection.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const First = () => {
        latest = usePlayerScreenData('player', 'league', { scoringSettings: { points: 1 } })
        firstEpoch ??= latest.readEpoch
        return null
    }
    await act(async () => { renderer = create(React.createElement(First)) })
    expect(requestedEpoch).toBe(firstEpoch)
    expect(latest.initialSettled).toBe(false)
    expect(latest.seasonLoading).toBe(false)
    await act(async () => { release(null) })
    expect(latest.initialSettled).toBe(true)
})

it('keeps historical season lines quiet during current game and stat signals', async () => {
    vi.useFakeTimers()
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => latest.handleSeasonSelect(2025))
    state.lines.mockClear()
    for (const topic of ['stat', 'game'] as const) {
        await act(async () => {
            notifyLeagueChange('league', { topic, scopes: null })
            await vi.advanceTimersByTimeAsync(250)
        })
    }
    expect(state.lines).not.toHaveBeenCalled()
    await act(async () => latest.handleSeasonSelect(2026))
    state.lines.mockClear()
    await act(async () => {
        notifyLeagueChange('league', { topic: 'stat', scopes: null })
        await vi.advanceTimersByTimeAsync(250)
    })
    expect(state.lines).toHaveBeenCalledExactlyOnceWith('player', 2026)
})

it('does not persist an unchanged season response on every live hint', async () => {
    vi.useFakeTimers()
    state.lines.mockImplementation(async () => [seasonLine()])
    await act(async () => { renderer = create(React.createElement(Probe)) })
    state.write.mockClear()
    await act(async () => {
        notifyLeagueChange('league', { topic: 'stat', scopes: null })
        await vi.advanceTimersByTimeAsync(250)
    })
    expect(state.lines).toHaveBeenCalledTimes(2)
    expect(state.write).not.toHaveBeenCalled()
    state.lines.mockResolvedValue([seasonLine({ points: 32 })])
    await act(async () => {
        notifyLeagueChange('league', { topic: 'stat', scopes: null })
        await vi.advanceTimersByTimeAsync(250)
    })
    expect(state.write).toHaveBeenCalledOnce()
    expect(latest.seasonAverages?.avgPoints).toBe(32)
})

it('skips identical projection responses with unchanged lines after game signals', async () => {
    vi.useFakeTimers()
    state.lines.mockImplementation(async () => [seasonLine()])
    state.projection.mockImplementation(async () => ({ player_id: 'player', projection_fantasy_points: 30 }))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    state.write.mockClear()
    await act(async () => {
        notifyLeagueChange('league', { topic: 'game', scopes: null })
        await vi.advanceTimersByTimeAsync(250)
    })
    expect(state.projection).toHaveBeenCalledTimes(2)
    expect(state.write).not.toHaveBeenCalled()
    state.projection.mockResolvedValue({ player_id: 'player', projection_fantasy_points: 42 })
    await act(async () => {
        notifyLeagueChange('league', { topic: 'game', scopes: null })
        await vi.advanceTimersByTimeAsync(250)
    })
    expect(state.write).toHaveBeenCalledOnce()
    expect(latest.nextProjection?.projection_fantasy_points).toBe(42)
})


it('ignores activity-only inventory without reloading player cards or roster actions', async () => {
    vi.useFakeTimers()
    await act(async () => { renderer = create(React.createElement(Probe)) })
    const before = reads()
    await act(async () => {
        notifyLeagueChange('league', { topic: 'inventory', scopes: null, details: [{ resource: 'activity', season_id: 'season' }] })
        await vi.advanceTimersByTimeAsync(250)
    })
    expect(reads()).toEqual(before)
    expect(latest.rosterRevision).toBe(0)
})

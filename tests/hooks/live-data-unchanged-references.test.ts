import React, { memo, useMemo } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameDay, LiveStatLine } from '@/lib/games'
import type { LineupPlayer, LineupSlot } from '@/lib/lineup'
import type { Matchup } from '@/lib/scoring'

type Lineup = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }
const boundary = vi.hoisted(() => ({
    games: vi.fn(), stats: vi.fn(), lineup: vi.fn(), matchup: vi.fn(),
    cache: vi.fn(), week: vi.fn(), online: true, hidden: false,
}))
vi.mock('@/lib/games', () => ({ getGameDay: boundary.games, getLivePlayerStats: boundary.stats }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: boundary.matchup, getLeagueWeekMatchups: async () => [] }))
vi.mock('@/lib/lineup', () => ({
    getWeeklyLineup: boundary.lineup, getWeekDays: boundary.week,
    clampDateToWeek: (date: string) => date, invalidateCachedRoster: vi.fn(),
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-13' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: boundary.cache, writePersistentCache: vi.fn() }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => boundary.online }))
vi.mock('@react-navigation/native', () => ({ useFocusEffect: vi.fn() }))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: vi.fn(() => ({})), disposeTableChangeSubscription: vi.fn(), reportRealtimeCleanup: vi.fn(),
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const TODAY = '2026-10-13'
const TOMORROW = '2026-10-14'
const START = new Date('2026-10-13T12:00:00Z').getTime()
const printMeasurement = console.info.bind(console)
const OWNER = { current: { id: 'mine' }, user: { id: 'user' }, league: { id: 'league' } }
const match: Matchup = {
    id: 'matchup', weekNumber: 1, seasonId: 'season', seasonYear: 2026,
    myMemberId: 'mine', opponentMemberId: 'theirs', myPoints: 0, opponentPoints: 0,
    myTeamName: 'Mine', opponentTeamName: 'Theirs', myUsername: 'me', opponentUsername: 'them',
    myWins: 0, myLosses: 0, opponentWins: 0, opponentLosses: 0, isFinalized: false, iWon: null,
}
const makePlayer = (index: number): LineupPlayer => ({
    playerId: `p${index}`, rosterPlayerId: `r${index}`, displayName: `Player ${index}`,
    position: 'PG', eligiblePositions: ['PG', 'G', 'UTIL'], nbaTeam: index % 2 ? 'ATL' : 'BOS',
    injuryStatus: null, nbaId: `${index}`,
})
const makeLineup = (offset: number): Lineup => {
    const players = Array.from({ length: 120 }, (_, index) => makePlayer(offset + index))
    return {
        starters: [...players.slice(0, 18).map((player) => ({ slotType: 'UTIL', player })),
            { slotType: 'UTIL', player: null }, { slotType: 'UTIL', player: null }],
        bench: players.slice(18, 108), ir: players.slice(108, 114), taxi: players.slice(114),
    }
}
const makeStats = (): Map<string, LiveStatLine> => new Map(Array.from({ length: 240 }, (_, index) => [
    `p${index}`, {
        points: 20, rebounds: 5, assists: 4, steals: 1, blocks: 1, turnovers: 2,
        threeMade: 2, fgMade: 8, fgAttempted: 15, ftMade: 2, ftAttempted: 3, fouls: 2,
        doubleDouble: false, tripleDouble: false, minutesPlayed: 28, didNotPlay: false,
    },
]))
const makeGameDay = (date: string): GameDay => ({
    games: [{
        id: `game-${date}`, nba_game_id: '0022600001', home_team: 'BOS', away_team: 'ATL',
        home_score: 60, away_score: 55, status: 'InProgress', game_status_text: 'Q3', game_date: date,
    }],
    startedTeams: new Set(['BOS', 'ATL']),
    teamMatchups: new Map([['BOS', { opponent: 'ATL', isHome: true }], ['ATL', { opponent: 'BOS', isHome: false }]]),
})
const copyLineup = (value: Lineup): Lineup => structuredClone(value)
const lineupSize = (value: Lineup) => value.starters.filter((slot) => slot.player).length
    + value.bench.length + value.ir.length + value.taxi.length
let statsByDate: Map<string, Map<string, LiveStatLine>>
let gamesByDate: Map<string, GameDay>
let lineups: Map<string, Lineup>
let failStats: boolean
let failGames: boolean
let failLineups: boolean
let delay: number
let renderer: ReactTestRenderer | null
let page: EventTarget
let events: EventTarget
let useLiveStats: typeof import('@/hooks/use-live-stats').useLiveStats
let useMatchupData: typeof import('@/hooks/use-matchup-data').useMatchupData
let live: ReturnType<typeof useLiveStats>
let matchup: ReturnType<typeof useMatchupData>
let metrics: {
    parents: number; rows: number; builds: number; viewRows: number; statConsumers: number;
    statRowsReceived: number; lineupPlayersReceived: number; fanouts: number; statEntriesIterated: number;
}
class SnapshotMap<Value> extends Map<string, Value> {
    override [Symbol.iterator]() {
        metrics.statEntriesIterated += this.size
        return super[Symbol.iterator]()
    }
}
const rowList = (value: Lineup) => [...value.starters.map((slot) => slot.player), ...value.bench, ...value.ir, ...value.taxi]

// The memo boundary uses the same changing data props as Home's MatchupRow.
// Its section memo depends on both lineups, as Home's LineupComparison does.
const Row = memo(function Row({ mine, theirs, stats, liveTeams, teamMatchups }: {
    mine: LineupPlayer | null; theirs: LineupPlayer | null; stats: Map<string, LiveStatLine>;
    liveTeams: Set<string>; teamMatchups: GameDay['teamMatchups'];
}) {
    metrics.rows += 1
    return React.createElement('row', {
        mine: mine?.playerId, theirs: theirs?.playerId, points: mine ? stats.get(mine.playerId)?.points : undefined,
        live: mine?.nbaTeam ? liveTeams.has(mine.nbaTeam) : false,
        opponent: mine?.nbaTeam ? teamMatchups.get(mine.nbaTeam)?.opponent : undefined,
    })
})
const StatsConsumer = memo(function StatsConsumer({ stats }: { stats: Map<string, LiveStatLine> }) {
    metrics.statConsumers += 1
    return React.createElement('stats', { total: [...stats.values()].reduce((total, value) => total + value.points, 0) })
})
const Probe = ({ owner = OWNER }: { owner?: typeof OWNER }) => {
    metrics.parents += 1
    const data = useMatchupData(owner.current, owner.user, owner.league)
    matchup = data
    const refreshSilently = data.refreshSilently
    const onSilentRefresh = React.useCallback(() => {
        metrics.fanouts += 1
        void refreshSilently()
    }, [refreshSilently])
    live = useLiveStats(data.selectedDate, onSilentRefresh)
    const rows = useMemo(() => {
        if (!data.myLineup || !data.oppLineup) return []
        metrics.builds += 1
        const mine = rowList(data.myLineup)
        const theirs = rowList(data.oppLineup)
        const result = mine.map((player, index) => ({ mine: player, theirs: theirs[index] ?? null }))
        metrics.viewRows += result.length
        return result
    }, [data.myLineup, data.oppLineup])
    return React.createElement('probe', null,
        React.createElement(StatsConsumer, { stats: live.liveStats }),
        ...rows.map((row, index) => React.createElement(Row, {
            key: index, ...row, stats: live.liveStats, liveTeams: live.liveTeams, teamMatchups: live.teamMatchups,
        })),
    )
}
const resetMetrics = () => {
    metrics = { parents: 0, rows: 0, builds: 0, viewRows: 0, statConsumers: 0, statRowsReceived: 0, lineupPlayersReceived: 0, fanouts: 0, statEntriesIterated: 0 }
    boundary.stats.mockClear(); boundary.games.mockClear(); boundary.lineup.mockClear(); boundary.matchup.mockClear()
}
const report = (workload: string) => {
    printMeasurement(JSON.stringify({ workload, ...metrics,
        statsReads: boundary.stats.mock.calls.length, gameReads: boundary.games.mock.calls.length,
        lineupReads: boundary.lineup.mock.calls.length, matchupReads: boundary.matchup.mock.calls.length,
    }))
}
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const dispatch = async (name: string) => { await act(async () => { events.dispatchEvent(new Event(name)) }) }
const visible = async (hidden: boolean) => {
    boundary.hidden = hidden
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
}
const poll = async () => {
    const elapsed = Date.now() - START
    const reads = boundary.stats.mock.calls.length
    await advance((Math.floor(elapsed / 15_000) + 1) * 15_000 - elapsed)
    if (boundary.stats.mock.calls.length > reads) {
        expect(live.freshness).toBe('refreshing')
        expect(live.liveTeams.size).toBe(0)
    }
    await advance(50)
    await advance(50)
}
const mount = async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await advance(50)
    resetMetrics()
}
beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); vi.resetModules(); vi.clearAllMocks()
    boundary.online = true; boundary.hidden = false
    delay = 50; failStats = false; failGames = false; failLineups = false; renderer = null
    statsByDate = new Map([[TODAY, makeStats()], [TOMORROW, makeStats()]])
    gamesByDate = new Map([[TODAY, makeGameDay(TODAY)], [TOMORROW, makeGameDay(TOMORROW)]])
    lineups = new Map([['mine', makeLineup(0)], ['theirs', makeLineup(120)]])
    events = new EventTarget(); page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => boundary.hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('window', events); vi.stubGlobal('document', page)
    vi.stubGlobal('navigator', { get onLine() { return boundary.online } })
    resetMetrics()
    boundary.stats.mockImplementation(async (date: string) => {
        const failed = failStats
        const value = new SnapshotMap([...statsByDate.get(date)!].map(([id, row]) => [id, { ...row }]))
        metrics.statRowsReceived += value.size
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        if (failed) throw new Error('stats unavailable')
        return value
    })
    boundary.games.mockImplementation(async (date: string) => {
        const failed = failGames
        const value = structuredClone(gamesByDate.get(date)!)
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        if (failed) throw new Error('games unavailable')
        return value
    })
    boundary.lineup.mockImplementation(async (memberId: string) => {
        const failed = failLineups
        const value = copyLineup(lineups.get(memberId)!)
        metrics.lineupPlayersReceived += lineupSize(value)
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        if (failed) throw new Error('lineup unavailable')
        return value
    })
    boundary.cache.mockReturnValue({
        today: TODAY, selectedDate: TODAY, matchup: match, weekDays: [], leagueMatchups: [],
        myLineup: copyLineup(lineups.get('mine')!), oppLineup: copyLineup(lineups.get('theirs')!),
    })
    boundary.matchup.mockResolvedValue(match)
    boundary.week.mockResolvedValue([])
    ;({ useLiveStats } = await import('@/hooks/use-live-stats'))
    ;({ useMatchupData } = await import('@/hooks/use-matchup-data'))
})
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('live data reference workload', () => {
    it('keeps equal lineups through eight identical 240-player snapshots without reducing reads', async () => {
        await mount()
        const mine = matchup.myLineup
        const theirs = matchup.oppLineup
        for (let cycle = 0; cycle < 8; cycle += 1) await poll()
        report('eight identical live polls')
        expect(boundary.stats).toHaveBeenCalledTimes(8)
        expect(boundary.games).toHaveBeenCalledTimes(8)
        expect(boundary.lineup).toHaveBeenCalledTimes(16)
        expect(metrics.fanouts).toBe(8)
        expect(matchup.myLineup).toBe(mine)
        expect(matchup.oppLineup).toBe(theirs)
        expect(metrics.builds).toBe(0)
        expect(metrics.rows).toBe(8 * 2 * 122)
        expect(matchup.myLineup?.starters.filter((slot) => !slot.player)).toHaveLength(2)
    })

    it('preserves Scheduled, InProgress and Final transitions and their polling cadence', async () => {
        const day = gamesByDate.get(TODAY)!
        day.games[0].status = 'Scheduled'; day.startedTeams.clear()
        await mount()
        expect(live.liveTeams.size).toBe(0)
        await poll(); await poll(); await poll()
        expect(boundary.stats).not.toHaveBeenCalled()
        day.games[0].status = 'InProgress'; day.startedTeams = new Set(['BOS', 'ATL'])
        await poll()
        expect(live.liveTeams.has('BOS')).toBe(true)
        day.games[0].status = 'Final'; day.games[0].game_status_text = 'Final'
        await poll()
        expect(live.liveTeams.size).toBe(0)
        expect(live.startedTeams.has('BOS')).toBe(true)
        expect(live.liveStats.get('p0')?.points).toBe(20)
        await poll(); await poll(); await poll()
        report('Scheduled to InProgress to Final, eight ticks')
        expect(boundary.stats).toHaveBeenCalledTimes(3)
        expect(metrics.fanouts).toBe(2)
    })

    it('applies DNP, downward corrections, row removal, and game metadata changes', async () => {
        await mount()
        statsByDate.get(TODAY)!.get('p0')!.didNotPlay = true
        statsByDate.get(TODAY)!.get('p0')!.minutesPlayed = 0
        await poll()
        expect(live.liveStats.get('p0')?.didNotPlay).toBe(true)
        statsByDate.get(TODAY)!.get('p0')!.didNotPlay = false
        statsByDate.get(TODAY)!.get('p0')!.points = 12
        statsByDate.get(TODAY)!.delete('p239')
        const game = gamesByDate.get(TODAY)!
        game.games[0].home_score = 57; game.games[0].game_status_text = 'Q4 2:00'
        game.teamMatchups.get('BOS')!.isHome = false
        await poll()
        report('DNP then corrected stats and metadata')
        expect(live.liveStats.get('p0')).toMatchObject({ points: 12, didNotPlay: false })
        expect(live.liveStats.has('p239')).toBe(false)
        expect(live.todaysGames[0]).toMatchObject({ home_score: 57, game_status_text: 'Q4 2:00' })
        expect(live.teamMatchups.get('BOS')?.isHome).toBe(false)
    })

    it('refreshes lineup edits despite unchanged stats and keeps every empty slot', async () => {
        await mount()
        const opponent = matchup.oppLineup
        const mine = lineups.get('mine')!
        const moved = mine.starters[0].player!
        mine.starters[0].player = mine.bench[0]; mine.bench[0] = moved
        mine.ir.pop(); mine.taxi[0].injuryStatus = 'OUT'
        await poll()
        report('lineup edit with equal stats')
        expect(matchup.myLineup?.starters[0].player?.playerId).toBe('p18')
        expect(matchup.myLineup?.bench[0].playerId).toBe('p0')
        expect(matchup.myLineup?.ir).toHaveLength(5)
        expect(matchup.myLineup?.taxi[0].injuryStatus).toBe('OUT')
        expect(matchup.myLineup?.starters.filter((slot) => !slot.player)).toHaveLength(2)
        expect(metrics.fanouts).toBe(1)
        expect(boundary.lineup).toHaveBeenCalledTimes(2)
        expect(matchup.oppLineup).toBe(opponent)
    })

    it.each([
        ['rosterPlayerId', 'replacement-roster-id'], ['playerId', 'replacement-player-id'],
        ['displayName', 'New name'], ['position', null], ['eligiblePositions', ['SF', 'F']],
        ['nbaTeam', 'DEN'], ['injuryStatus', 'OUT'], ['nbaId', null],
    ] satisfies [keyof LineupPlayer, string | string[] | null][])(
        'keeps changed player %s in the refreshed lineup', async (field, value) => {
            await mount()
            Object.assign(lineups.get('mine')!.bench[0], { [field]: value })
            await poll()
            expect(matchup.myLineup?.bench[0][field]).toEqual(value)
        },
    )

    it('applies slot types, order, added players and confirmed empty reserves', async () => {
        await mount()
        const mine = lineups.get('mine')!
        mine.starters[0].slotType = 'PG'
        ;[mine.starters[0], mine.starters[1]] = [mine.starters[1], mine.starters[0]]
        mine.bench.push(makePlayer(999)); mine.ir = []; mine.taxi = []
        await poll()
        expect(matchup.myLineup).toEqual(mine)
        expect(matchup.myLineup?.starters[1].slotType).toBe('PG')
        expect(matchup.myLineup?.bench.at(-1)?.playerId).toBe('p999')
        expect(matchup.myLineup?.ir).toEqual([]); expect(matchup.myLineup?.taxi).toEqual([])
    })

    it('does not reuse equal lineups across a selected-date change or apply the old read', async () => {
        await mount()
        const original = matchup.myLineup
        delay = 500
        lineups.get('mine')!.bench[0].displayName = 'Old date'
        await act(async () => { void matchup.refreshSilently() })
        await act(async () => { matchup.setSelectedDate(TOMORROW) })
        delay = 50
        lineups.get('mine')!.bench[0].displayName = 'Player 18'
        let done!: Promise<unknown>
        await act(async () => { done = matchup.loadLineups(match, TOMORROW) })
        await advance(50); await act(async () => { await done })
        const current = matchup.myLineup
        await advance(450)
        report('date change during old reads')
        expect(matchup.selectedDate).toBe(TOMORROW)
        expect(current).not.toBe(original)
        expect(current).toEqual(original)
        expect(matchup.myLineup).toBe(current)
        expect(matchup.myLineup?.bench[0].displayName).toBe('Player 18')
        expect(live.liveStats.size).toBe(240)
        expect(live.liveTeams.size).toBe(0)
    })

    it.each(['stats', 'games'] as const)('keeps partial %s failures stale and recovers without losing successful data', async (failure) => {
        await mount()
        const oldStats = live.liveStats
        if (failure === 'stats') { failStats = true; gamesByDate.get(TODAY)!.games[0].home_score = 71 }
        else { failGames = true; statsByDate.get(TODAY)!.get('p0')!.points = 31 }
        await poll()
        expect(live.freshness).toBe('failed')
        expect(live.liveTeams.size).toBe(0)
        expect(metrics.fanouts).toBe(0)
        if (failure === 'stats') { expect(live.liveStats).toBe(oldStats); expect(live.todaysGames[0].home_score).toBe(71) }
        else expect(live.liveStats.get('p0')?.points).toBe(31)
        failStats = false; failGames = false
        await dispatch('focus'); await advance(50); await advance(50)
        report(`partial ${failure} failure and focus recovery`)
        expect(live.freshness).toBe('fresh')
        expect(live.liveTeams.has('BOS')).toBe(true)
        expect(metrics.fanouts).toBe(1)
    })

    it('retains date-load failure clearing and the explicit retry', async () => {
        await mount()
        failLineups = true
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        await act(async () => { matchup.setSelectedDate(TOMORROW) })
        let done!: Promise<unknown>
        await act(async () => { done = matchup.loadLineups(match, TOMORROW) })
        await advance(50); await act(async () => { await done })
        expect(matchup.myLineup).toBeNull(); expect(matchup.oppLineup).toBeNull(); expect(matchup.lineupError).toBe(true)
        failLineups = false
        await act(async () => { done = matchup.loadLineups(match, TOMORROW) })
        await advance(50); await act(async () => { await done })
        expect(matchup.myLineup?.bench).toHaveLength(90); expect(matchup.lineupError).toBe(false)
        error.mockRestore()
    })

    it('defers hidden work and catches up once on resume, even with equal stats', async () => {
        await mount()
        await visible(true); await advance(60_000)
        expect(boundary.stats).not.toHaveBeenCalled(); expect(boundary.lineup).not.toHaveBeenCalled()
        lineups.get('mine')!.taxi.pop()
        await visible(false); await dispatch('focus'); await advance(50); await advance(50)
        report('hidden for 60 seconds then resume and focus')
        expect(boundary.stats).toHaveBeenCalledTimes(1); expect(boundary.games).toHaveBeenCalledTimes(1)
        expect(metrics.fanouts).toBe(1); expect(matchup.myLineup?.taxi).toHaveLength(5)
    })

    it('rejects pre-disconnect snapshots then reads the current data on return', async () => {
        await mount()
        delay = 500
        await dispatch('online')
        boundary.online = false; await dispatch('offline')
        expect(live.freshness).toBe('offline'); expect(live.liveTeams.size).toBe(0)
        statsByDate.get(TODAY)!.get('p0')!.points = 9
        boundary.online = true; delay = 50; await dispatch('online')
        await advance(500); await advance(50); await advance(50)
        report('disconnect during read then resume')
        expect(boundary.stats).toHaveBeenCalledTimes(2)
        expect(live.liveStats.get('p0')?.points).toBe(9)
        expect(metrics.fanouts).toBe(1)
    })

    it('rejects equal pending lineup results from the previous owner', async () => {
        await mount()
        delay = 500
        await act(async () => { void matchup.refreshSilently() })
        boundary.cache.mockReturnValue(undefined)
        const owner = { current: { id: 'new-member' }, user: { id: 'new-user' }, league: { id: 'new-league' } }
        await act(async () => { renderer!.update(React.createElement(Probe, { owner })) })
        await advance(500)
        expect(matchup.myLineup).toBeNull(); expect(matchup.oppLineup).toBeNull(); expect(matchup.matchup).toBeUndefined()
    })
})

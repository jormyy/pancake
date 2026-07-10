import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'
import type { Matchup } from '@/lib/scoring'

const { getWeeklyLineup, readPersistentCache } = vi.hoisted(() => ({
    getWeeklyLineup: vi.fn(),
    readPersistentCache: vi.fn(),
}))

vi.mock('@react-navigation/native', () => ({ useFocusEffect: vi.fn() }))
vi.mock('@/lib/scoring', () => ({ getLeagueWeekMatchups: vi.fn(), getMyMatchup: vi.fn() }))
vi.mock('@/lib/lineup', () => ({
    clampDateToWeek: vi.fn(),
    getWeekDays: vi.fn(),
    getWeeklyLineup,
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-07-09' }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache, writePersistentCache: vi.fn() }))
vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }),
    disposeTableChangeSubscription: vi.fn(),
    subscribeToTableChanges: vi.fn(() => ({})),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

const matchup: Matchup = {
    id: 'matchup', weekNumber: 1, myPoints: 0, opponentPoints: 0,
    myTeamName: 'Mine', opponentTeamName: 'Theirs', myUsername: 'me', opponentUsername: 'them',
    myWins: 0, myLosses: 0, opponentWins: 0, opponentLosses: 0, isFinalized: false,
    iWon: null, myMemberId: 'member-a', opponentMemberId: 'member-b', seasonId: 'season', seasonYear: 2026,
}
const lineup = (id: string) => ({
    starters: [], bench: [{
        rosterPlayerId: `roster-${id}`, playerId: id, displayName: id, position: 'PG',
        eligiblePositions: ['PG'], nbaTeam: 'LAL', injuryStatus: null, nbaId: null,
    }], ir: [], taxi: [],
})

describe('useMatchupData date ownership', () => {
    it('does not let an old action reload cancel or overwrite the selected day', async () => {
        readPersistentCache.mockReturnValue({
            today: '2026-07-09', selectedDate: '2026-07-09', matchup, weekDays: [], leagueMatchups: [],
            myLineup: lineup('old-mine'), oppLineup: lineup('old-opp'),
        })
        const mine = deferred<ReturnType<typeof lineup>>()
        const opponent = deferred<ReturnType<typeof lineup>>()
        getWeeklyLineup.mockImplementation((memberId: string, _leagueId: string, _seasonId: string, _week: number, date: string) => {
            expect(date).toBe('2026-07-10')
            return memberId === 'member-a' ? mine.promise : opponent.promise
        })
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => {
            latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let currentLoad!: Promise<unknown>
        await act(async () => {
            latest.setSelectedDate('2026-07-10')
            currentLoad = latest.loadLineups(matchup, '2026-07-10')
            await latest.loadMyLineup(matchup, '2026-07-09')
        })
        expect(getWeeklyLineup).toHaveBeenCalledTimes(2)
        await act(async () => {
            mine.resolve(lineup('new-mine'))
            opponent.resolve(lineup('new-opp'))
            await currentLoad
        })

        expect(latest.selectedDate).toBe('2026-07-10')
        expect(latest.myLineup?.bench[0]?.playerId).toBe('new-mine')
        expect(latest.oppLineup?.bench[0]?.playerId).toBe('new-opp')
        await act(async () => { renderer.unmount() })
    })
})

import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMatchupForecast } from '@/hooks/use-matchup-forecast'
import type { Matchup } from '@/lib/scoring'

const f = vi.hoisted(() => ({
    rpc: vi.fn(), subscribe: vi.fn(() => ({})), dispose: vi.fn(async () => {}), write: vi.fn(),
    read: vi.fn(), focused: true, active: true, owner: 'user', generation: 1,
}))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => f.focused }))
vi.mock('@/hooks/use-browser-read-activity', () => ({ useBrowserReadActivity: () => ({ active: f.active, revision: 0 }) }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: f.read, writePersistentCache: f.write }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: f.rpc } }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => f.generation, sessionOwner: () => f.owner }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: f.subscribe, disposeTableChangeSubscription: f.dispose, reportRealtimeCleanup: (_label: string, cleanup: Promise<void>) => { void cleanup } }))
vi.mock('@/lib/league-changes', () => ({
    listenForLeagueChanges: () => () => {}, leagueChangeAffects: () => true,
    deferLeagueRefresh: (read: () => Promise<unknown>) => ({ trigger: () => { void read() }, cancel: vi.fn() }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const matchup = { id: 'matchup', seasonId: 'season', myMemberId: 'mine', opponentMemberId: 'other' } as Matchup
let output: ReturnType<typeof useMatchupForecast>
let screen: ReactTestRenderer
function Probe({ user = 'user', league = 'league' }: { user?: string; league?: string }) {
    output = useMatchupForecast(user, league, matchup)
    return null
}
beforeEach(() => { vi.clearAllMocks(); f.focused = true; f.active = true; f.owner = 'user'; f.generation = 1; f.read.mockReturnValue(undefined); f.rpc.mockResolvedValue({ data: null, error: null }) })
afterEach(async () => { await act(async () => screen?.unmount()) })
it('reads only the cached RPC and scopes completion updates to the league', async () => {
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(f.rpc).toHaveBeenCalledWith('get_matchup_forecast', { p_matchup_id: 'matchup' })
    expect(f.subscribe.mock.calls[0][1].watches[0]).toMatchObject({ table: 'matchup_forecasts', filter: 'league_id=eq.league' })
    expect(output.forecast).toBeNull()
    expect(f.write).toHaveBeenCalledWith('pancake:matchup-forecast:v1:user:league:matchup', null)
})
it('does not read or subscribe while hidden', async () => {
    f.active = false
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(f.rpc).not.toHaveBeenCalled()
    expect(f.subscribe).not.toHaveBeenCalled()
})
it('drops a late result from the old account', async () => {
    let resolve!: (value: unknown) => void
    f.rpc.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await act(async () => { screen = create(React.createElement(Probe)) })
    f.owner = 'second'
    f.generation += 1
    await act(async () => { screen.update(React.createElement(Probe, { user: 'second', league: 'second-league' })) })
    await act(async () => { resolve({ data: { matchupId: 'old-private-result' }, error: null }) })
    expect(output.forecast).toBeNull()
    expect(f.write.mock.calls.some(call => call[1]?.matchupId === 'old-private-result')).toBe(false)
    expect(f.dispose).toHaveBeenCalled()
})

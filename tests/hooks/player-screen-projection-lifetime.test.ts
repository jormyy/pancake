import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { setLeagueChangesConnected } from '@/lib/league-changes'

const state = vi.hoisted(() => ({ focused: true, rpc: vi.fn() }))
vi.mock('@react-navigation/native', async () => {
    const { useEffect } = await import('react')
    return { useFocusEffect: (callback: React.EffectCallback) => {
        const focused = state.focused
        useEffect(() => focused ? callback() : undefined, [callback, focused])
    } }
})
vi.mock('@/lib/players', () => ({
    getPlayer: async () => ({ id: 'player', nba_team: 'LAL' }), getAvailableSeasons: async () => [2026],
    getPlayerSeasonAveragesFromView: async () => null, getPlayerGameLog: async () => ({ games: [], hasMore: false }),
    getPlayerFantasyPoints: async () => [], getPlayerTransactionHistory: async () => [],
}))
vi.mock('@/components/player/season-data', () => ({ getPlayerSeasonLines: async () => [], getPlayerScoringSettings: async () => ({}), summarizePlayerSeason: () => ({ games: [], averages: null, fantasyPointsMap: null, avgFantasyPoints: 0, includesLive: false }) }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => undefined, writePersistentCache: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {
    rpc: state.rpc,
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('reads the current projection after route suspension before the old shared read settles', async () => {
    setLeagueChangesConnected('league', true)
    let release!: (value: unknown) => void
    state.rpc.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
        .mockResolvedValue({ data: [{ player_id: 'player', projection_fantasy_points: 42 }], error: null })
    let latest!: ReturnType<typeof usePlayerScreenData>
    const Probe = () => { latest = usePlayerScreenData('player', 'league'); return null }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        state.focused = false
        await act(async () => { renderer.update(React.createElement(Probe)) })
        state.focused = true
        await act(async () => { renderer.update(React.createElement(Probe)) })
        expect(state.rpc).toHaveBeenCalledTimes(2)
        expect(latest.nextProjection?.projection_fantasy_points).toBe(42)
        await act(async () => { release({ data: [{ player_id: 'player', projection_fantasy_points: 5 }], error: null }) })
        expect(latest.nextProjection?.projection_fantasy_points).toBe(42)
    } finally { await act(async () => { renderer.unmount() }); setLeagueChangesConnected('league', false) }
})

import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { seasonLine } from '@/tests/components/player/season-fixtures'

const state = vi.hoisted(() => ({ averages: vi.fn(), lines: vi.fn(), player: vi.fn(), history: vi.fn(), projection: vi.fn() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('@/lib/players', () => ({ getPlayer: state.player, getAvailableSeasons: () => new Promise(() => {}), getPlayerTransactionHistory: state.history, getPlayerSeasonAverages: state.averages, getPlayerAverageFantasyPoints: async () => 35 }))
vi.mock('@/components/player/season-data', async original => ({ ...await original<typeof import('@/components/player/season-data')>(), getPlayerSeasonLines: state.lines, getPlayerScoringSettings: () => new Promise(() => {}) }))
vi.mock('@/lib/projections', () => ({ getPlayerProjection: state.projection }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => undefined, writePersistentCache: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('renders the player and averages while the game log and supporting reads remain pending', async () => {
    state.player.mockResolvedValue({ id: 'player', display_name: 'First paint', nba_team: 'BOS' })
    state.averages.mockResolvedValue({ gamesPlayed: 2, avgPoints: 24, avgRebounds: 5, avgAssists: 7, avgSteals: 1, avgBlocks: 0, avgTurnovers: 3, avgThreePointersMade: 2, avgFieldGoalsMade: 8, avgFieldGoalsAttempted: 16, avgFreeThrowsMade: 6, avgFreeThrowsAttempted: 8, avgMinutesPlayed: 30, doubleDoubles: 1, tripleDoubles: 0 })
    for (const read of [state.lines, state.history, state.projection]) read.mockReturnValue(new Promise(() => {}))
    let latest!: ReturnType<typeof usePlayerScreenData>
    const Probe = () => { latest = usePlayerScreenData('player', 'league', { scoringSettings: { points: 1, assists: 2, turnovers: -1 } }); return null }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.player?.display_name).toBe('First paint')
        expect(latest.seasonAverages?.avgPoints).toBe(24)
        expect(latest.avgFantasyPoints).toBe(35)
        expect(latest.seasonLoading).toBe(false)
        expect(latest.gameLogLoading).toBe(true)
        expect(latest.gameLog).toEqual([])
        expect(latest.projectionSettled).toBe(false)
        expect(latest.transactionsSettled).toBe(false)
    } finally { await act(async () => renderer.unmount()) }
})

it('does not show another owner the prior average cache during an account change', async () => {
    state.averages.mockResolvedValue({ gamesPlayed: 2, avgPoints: 24 })
    const Probe = ({ owner, authorized }: { owner: string; authorized: boolean }) => {
        latest = usePlayerScreenData('player', 'league', { ownerKey: owner, authorized })
        return null
    }
    let latest!: ReturnType<typeof usePlayerScreenData>
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe, { owner: 'first', authorized: true })) })
        expect(latest.seasonAverages?.avgPoints).toBe(24)
        await act(async () => renderer.update(React.createElement(Probe, { owner: 'second', authorized: false })))
        expect(latest.seasonAverages).toBeNull()
    } finally { await act(async () => renderer.unmount()) }
})

it('keeps the server fantasy average while the game log arrives before scoring', async () => {
    state.lines.mockResolvedValue([seasonLine()])
    let latest!: ReturnType<typeof usePlayerScreenData>
    const Probe = () => { latest = usePlayerScreenData('player', 'league'); return null }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.gameLog).toHaveLength(1)
        expect(latest.avgFantasyPoints).toBe(35)
    } finally { await act(async () => renderer.unmount()) }
})

it('keeps server averages when a partial game log finishes', async () => {
    state.averages.mockResolvedValue({ gamesPlayed: 80, avgPoints: 24 })
    state.lines.mockResolvedValue([seasonLine({ points: 1 })])
    let latest!: ReturnType<typeof usePlayerScreenData>
    const Probe = () => { latest = usePlayerScreenData('player', 'league', { scoringSettings: { points: 1 } }); return null }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.gameLog).toHaveLength(1)
        expect(latest.seasonAverages?.gamesPlayed).toBe(80)
        expect(latest.seasonAverages?.avgPoints).toBe(24)
        expect(latest.avgFantasyPoints).toBe(35)
    } finally { await act(async () => renderer.unmount()) }
})

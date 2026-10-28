import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { clearScreenViews, saveScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import { currentSeasonYear } from '@/lib/shared/season'
import { seasonLine } from '@/tests/components/player/season-fixtures'

const state = vi.hoisted(() => ({ owner: 'account', generation: 0, read: vi.fn() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => state.owner, sessionGeneration: () => state.generation, onSessionCachesCleared: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: state.owner }, access_token: 'synthetic' } } }) } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const payload = () => ({ context: { version: '1' }, player: { id: 'player', display_name: 'First paint', nba_team: 'BOS' }, averages: { gamesPlayed: 80, avgPoints: 24 }, avgFantasyPoints: 35, lines: [seasonLine({ points: 1 })], transactions: [], availableSeasons: [currentSeasonYear()], nextProjection: null })
let renderer: ReactTestRenderer | undefined
let latest: ReturnType<typeof usePlayerScreenData>
const renders: { player: string | undefined; points: number | undefined; games: number }[] = []
const Probe = ({ owner = 'account', authorized = true }: { owner?: string; authorized?: boolean }) => {
    state.owner = owner
    latest = usePlayerScreenData('player', 'league', { ownerKey: JSON.stringify([owner, 'member']), authorized, scoringSettings: { points: 1 } })
    renders.push({ player: latest.player?.display_name, points: latest.seasonAverages?.avgPoints, games: latest.gameLog.length })
    return null
}
beforeEach(() => {
    state.owner = 'account'; state.generation += 1; state.read.mockReset(); clearScreenViews(); renders.length = 0
    state.read.mockResolvedValue(payload())
    vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify(input.includes('/version?') ? { version: '1', changes: [] } : { ok: true, view: await state.read() }))))
})
afterEach(async () => { if (renderer) await act(async () => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals() })

it('renders the entire saved player view on the first render while the current read remains pending', async () => {
    saveScreenView(screenScope('player', 'league', 'member', { playerId: 'player', seasonYear: currentSeasonYear(), section: 'overview' }), payload(), '1')
    state.read.mockReturnValue(new Promise(() => {}))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(renders[0]).toEqual({ player: 'First paint', points: 24, games: 1 })
    expect(latest.seasonLoading).toBe(false)
    expect(latest.gameLogLoading).toBe(false)
    expect(latest.avgFantasyPoints).toBe(35)
    expect(latest.projectionSettled).toBe(true)
    expect(latest.transactionsSettled).toBe(false)
})
it('never gives the next account the prior cached averages', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(latest.seasonAverages?.avgPoints).toBe(24)
    renders.length = 0
    await act(async () => { renderer!.update(React.createElement(Probe, { owner: 'second', authorized: false })) })
    expect(renders[0]).toEqual({ player: undefined, points: undefined, games: 0 })
    expect(latest.seasonAverages).toBeNull()
})
it('keeps the server fantasy average when game data arrives without scoring settings', async () => {
    state.read.mockResolvedValue({ ...payload(), scoringSettings: {} })
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(latest.gameLog).toHaveLength(1)
    expect(latest.avgFantasyPoints).toBe(35)
})
it('keeps full server averages when the view contains a partial game log', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(latest.gameLog).toHaveLength(1)
    expect(latest.seasonAverages?.gamesPlayed).toBe(80)
    expect(latest.seasonAverages?.avgPoints).toBe(24)
    expect(latest.avgFantasyPoints).toBe(35)
})

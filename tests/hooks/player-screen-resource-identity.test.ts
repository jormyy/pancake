import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'

const mocks = vi.hoisted(() => ({
    readPersistentCache: vi.fn(),
    generation: 1,
    pending: new Promise<never>(() => undefined),
}))
vi.mock('@/lib/session-cache-registry', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/session-cache-registry')>(),
    sessionGeneration: () => mocks.generation, sessionOwner: () => 'owner',
}))

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('@/lib/players', () => ({
    getAvailableSeasons: vi.fn(() => mocks.pending),
    getPlayer: vi.fn(() => mocks.pending),
    getPlayerTransactionHistory: vi.fn(() => mocks.pending),
}))
vi.mock('@/lib/projections', () => ({ getPlayerProjection: vi.fn(() => mocks.pending) }))
vi.mock('@/components/player/season-data', async importOriginal => ({
    ...await importOriginal<typeof import('@/components/player/season-data')>(),
    getPlayerSeasonLines: () => mocks.pending, getPlayerScoringSettings: () => mocks.pending,
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: mocks.readPersistentCache,
    writePersistentCache: vi.fn(),
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-07-09' }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))
vi.mock('@/lib/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    eq: vi.fn(() => ({ maybeSingle: vi.fn(() => mocks.pending) })),
                })),
            })),
        })),
    },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('player screen resource identity', () => {
    it('restores the same owner snapshot after a session generation change while rejecting old reads', async () => {
        const saved = { today: '2026-07-09', player: { id: 'player-a', display_name: 'Saved', nba_team: 'LAL' },
            selectedSeason: 2025, seasons: [], transactions: [] }
        const entries = new Map<string, typeof saved>()
        mocks.readPersistentCache.mockImplementation((key: string) => entries.get(key))
        let latest!: ReturnType<typeof usePlayerScreenData>
        const Probe = ({ owner = 'owner' }: { owner?: string }) => {
            latest = usePlayerScreenData('player-a', 'league', { ownerKey: owner })
            return null
        }
        let renderer!: ReactTestRenderer
        mocks.generation = 1
        await act(async () => { renderer = create(React.createElement(Probe)) })
        const originalEpoch = latest.readEpoch
        expect(latest.isCurrentRead(originalEpoch)).toBe(true)
        const cacheKey = mocks.readPersistentCache.mock.calls.at(-1)![0] as string
        entries.set(cacheKey, saved)
        await act(async () => renderer.unmount())
        mocks.generation = 2
        expect(latest.isCurrentRead(originalEpoch)).toBe(false)
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.player?.display_name).toBe('Saved')
        expect(latest.selectedSeason).toBe(2025)
        expect(mocks.readPersistentCache.mock.calls.at(-1)![0]).toBe(cacheKey)
        expect(latest.readEpoch).not.toBe(originalEpoch)
        expect(latest.isCurrentRead(originalEpoch)).toBe(false)
        await act(async () => renderer.update(React.createElement(Probe, { owner: 'someone-else' })))
        expect(latest.player).toBeNull()
        await act(async () => renderer.unmount())
    })

    it('hides cached player state on the first render for a new player key', async () => {
        mocks.readPersistentCache.mockImplementation((key: string) => key.endsWith(':player-a') ? {
            today: '2026-07-09',
            player: { id: 'player-a', display_name: 'Player A', nba_team: 'LAL' },
            availableSeasons: [2026],
            selectedSeason: 2026,
            seasons: [],
            nextProjection: null,
            transactions: [{ id: 'old-transaction' }],
        } : undefined)
        const snapshots: {
            requested: string
            playerId?: string
            loading: boolean
            transactions: number
        }[] = []
        const Probe = ({ playerId }: { playerId: string }) => {
            const value = usePlayerScreenData(playerId, 'league')
            snapshots.push({
                requested: playerId,
                playerId: value.player?.id,
                loading: value.loading,
                transactions: value.transactions.length,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { playerId: 'player-a' })) })
        await act(async () => { renderer.update(React.createElement(Probe, { playerId: 'player-b' })) })

        expect(snapshots.find((snapshot) => snapshot.requested === 'player-b')).toEqual({
            requested: 'player-b',
            playerId: undefined,
            loading: true,
            transactions: 0,
        })
        await act(async () => { renderer.unmount() })
    })
})

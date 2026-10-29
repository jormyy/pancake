import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { TradeBlockListingRow } from '@/components/trades/TradeListRow'
import type { TradeBlockItem } from '@/lib/trades'

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: state.data, loaded: true, refresh: vi.fn() }) }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => 'viewer', onSessionCachesCleared: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/trades/TradeCard', () => ({ TradeCard: 'TradeCard' }))
vi.mock('@/components/trades/TradeBlockNoteEditor', () => ({ TradeBlockNoteEditor: 'TradeBlockNoteEditor' }))
vi.mock('@/hooks/use-player-age', () => ({ usePlayerAge: () => null }))

const listing: TradeBlockItem = {
    id: 'listing', memberId: 'other-member', teamName: 'Other team', updatedAt: '', note: null,
    asset: { kind: 'player', playerId: 'ja', playerName: 'Ja Morant', position: 'PG', nbaTeam: 'MEM',
        avgFantasyPoints: 37.33, avgMinutesPlayed: 24.7 },
}

afterEach(() => vi.clearAllMocks())

it.each([
    ['another team', { teammate: 25 }, { teammate: { avg_minutes_played: 20 } }],
    ['an empty roster', {}, {}],
    ['older roster averages', { ja: 0 }, { ja: { avg_minutes_played: 0 } }],
])('renders the view averages with %s', async (_label, avgMap, avgStatsMap) => {
    state.data = { items: [listing], block: [listing], roster: [], picks: [], avgMap, avgStatsMap }
    const Probe = () => {
        const block = useTradeBlock('viewer-member', 'league')
        return React.createElement(TradeBlockListingRow, {
            item: { _type: 'blockItem', item: block.items[0] }, myMemberId: 'viewer-member',
            blockBusyId: null, onRemove: vi.fn(), onSaveNote: vi.fn(),
        })
    }
    let renderer!: ReturnType<typeof create>
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        const stats = renderer.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
        expect(stats).toContain('37.3 FP · 24.7 mins')
    } finally {
        await act(async () => renderer?.unmount())
    }
})

it('rejects erased averages in the browser check', async () => {
    const { assertListingAverages } = await import('./e2e/trade-block-averages.mjs')
    const expected = '37.3 FP · 24.7 mins'
    expect(() => assertListingAverages([{ player: 'Ja Morant', expected, actual: '0.0 FP · 0.0 mins' }])).toThrow()
    expect(() => assertListingAverages([])).toThrow()
    expect(() => assertListingAverages([{ player: 'Ja Morant', expected, actual: expected }])).not.toThrow()
})

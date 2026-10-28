import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import type { TradeParticipantView } from '@/lib/trade-ui-model'
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: <Value,>(value: Value) => value },
    Text: 'Text',
    TextInput: 'TextInput',
    useWindowDimensions: () => ({ width: 1_024, height: 768 }),
    View: 'View',
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: 'MultiTeamTradeOverview' }))
vi.mock('@/components/trades/ParticipantTradePanel', () => ({ ParticipantTradePanel: 'ParticipantTradePanel' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const participant = (memberId: string, destinationId: string): TradeParticipantView => ({
    memberId,
    destinationIds: [destinationId],
    defaultDestinationId: destinationId,
    roster: [],
    picks: [],
    selectedPlayerIds: new Set(),
    selectedPickIds: new Set(),
    playerDestinationIds: {},
    pickDestinationIds: {},
    faabInputs: {},
})

const props = {
    participants: [participant('me', 'them'), participant('them', 'me')],
    items: [], myMemberId: 'me', faabEnabled: true, notes: '', notesError: null,
    expirationDays: '3', expirationError: null, rosterError: null, rosterLoading: false,
    avgMap: new Map(), avgStatsMap: new Map(), participantName: (id: string) => id,
    onRetry: vi.fn(), onTogglePlayer: vi.fn(), onTogglePick: vi.fn(), onRemoveAsset: vi.fn(),
    onDestinationChange: vi.fn(), onPlayerDestinationChange: vi.fn(), onPickDestinationChange: vi.fn(),
    onFaabChange: vi.fn(), onNotesChange: vi.fn(), onExpirationDaysChange: vi.fn(),
}

afterEach(() => { vi.useRealTimers() })

const render = async (extra: Record<string, unknown>) => {
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(MultiTeamTradeBuilder, { ...props, ...extra })) })
    return renderer
}

it('hides offer terms when building an analysis', async () => {
    const renderer = await render({ showTerms: false })
    expect(renderer.root.findAllByType('TextInput' as React.ElementType)).toHaveLength(0)
    await act(async () => { renderer.unmount() })
})

it('reviews a blank expiration as no expiry', async () => {
    const renderer = await render({ reviewOnly: true, expirationDays: '' })
    expect(JSON.stringify(renderer.toJSON())).toContain('No expiry')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Expires in')
    await act(async () => { renderer.unmount() })
})

it('reviews the expiry capped at the trade deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const renderer = await render({ reviewOnly: true, expirationDays: '7', leagueStatus: 'active', tradeDeadline: '2026-01-02' })
    const capped = 'Jan 2, 2026, 8:59 PM PT'
    expect(JSON.stringify(renderer.toJSON())).toContain(capped)
    await act(async () => { renderer.unmount() })
})

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))

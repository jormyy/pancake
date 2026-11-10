import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { ActivityFeed } from '@/components/league/LeagueActivityFeed'
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/components/player/PlayerRowContent', () => ({ PlayerRowContent: 'PlayerRowContent' }))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }))
vi.mock('@/components/ui', () => ({ usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/lib/format', () => ({ timeAgo: () => '', playerHeadshotUrl: () => null }))
vi.mock('@/lib/transactions', () => ({ TRANSACTION_LABELS: {}, activityEventCategory: () => '' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps the same Activity list and rows while exposing pull refresh', async () => {
    const refresh = vi.fn(async () => {})
    const transactions: React.ComponentProps<typeof ActivityFeed>['transactions'] = []
    let screen!: ReactTestRenderer
    try {
        await act(async () => { screen = create(React.createElement(ActivityFeed, { transactions, onRefresh: refresh, refreshing: false })) })
        const list = screen.root.findByType('FlashList' as React.ElementType)
        expect(list.props.onRefresh).toBe(refresh)
        await act(async () => { await list.props.onRefresh() })
        expect(refresh).toHaveBeenCalledOnce()
        await act(async () => screen.update(React.createElement(ActivityFeed, { transactions, onRefresh: refresh, refreshing: true })))
        expect(screen.root.findByType('FlashList' as React.ElementType)).toBe(list)
        expect(list.props.data).toBe(transactions)
        expect(list.props.refreshing).toBe(true)
    } finally { await act(async () => screen.unmount()) }
})

it('refreshes Activity from a web pull at the top of its list', async () => {
    const refresh = vi.fn(async () => {})
    let screen!: ReactTestRenderer
    try {
        await act(async () => { screen = create(React.createElement(ActivityFeed, { transactions: [], onRefresh: refresh })) })
        const list = screen.root.findByType('FlashList' as React.ElementType)
        expect(list.props.onTouchStart).toEqual(expect.any(Function))
        await act(async () => {
            list.props.onTouchStart({ nativeEvent: { touches: [{ pageX: 100, pageY: 100 }] } })
            list.props.onTouchMove({ nativeEvent: { touches: [{ pageX: 100, pageY: 200 }] } })
            list.props.onTouchEnd()
        })
        expect(refresh).toHaveBeenCalledOnce()
    } finally { await act(async () => screen.unmount()) }
})

it.each(['trade_completed', 'commissioner_announcement'])('links grouped players only for %s', async transactionType => {
    const item: React.ComponentProps<typeof ActivityFeed>['transactions'][number] = {
        id: 'event', memberId: null, teamName: 'Team', playerId: null, playerName: 'Trade completed', position: null,
        eligiblePositions: [], nbaId: null, transactionType, occurredAt: '2026-11-10T12:00:00Z', isSystem: true,
        tradePlayers: [
            { kind: 'player', playerId: 'low', playerName: 'Low', tradeValue: 100, fromMemberId: 'a', toMemberId: 'b', fromTeamName: 'A', toTeamName: 'B' },
            { kind: 'player', playerId: 'high', playerName: 'High', tradeValue: 900, fromMemberId: 'b', toMemberId: 'a', fromTeamName: 'B', toTeamName: 'A' },
        ],
    }
    let screen!: ReactTestRenderer
    let row!: ReactTestRenderer
    push.mockClear()
    try {
        await act(async () => { screen = create(React.createElement(ActivityFeed, { transactions: [item] })) })
        const renderItem = screen.root.findByType('FlashList' as React.ElementType).props.renderItem
        await act(async () => { row = create(renderItem({ item })) })
        const links = row.root.findAllByType('Pressable' as React.ElementType)
        expect(links.map(link => link.props.accessibilityLabel)).toEqual(transactionType === 'trade_completed' ? ['View High stats', 'View Low stats'] : [])
        if (transactionType === 'trade_completed') {
            await act(async () => links[0].props.onPress())
            expect(push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/player/[id]', params: expect.objectContaining({ id: 'high' }) }))
        }
    } finally {
        if (row) await act(async () => row.unmount())
        if (screen) await act(async () => screen.unmount())
    }
})

it.each(['trade_in', 'trade_out', 'fa_add'])('opens individual stats only for trade activity: %s', async transactionType => {
    const item: React.ComponentProps<typeof ActivityFeed>['transactions'][number] = {
        id: 'event', memberId: 'a', teamName: 'A', playerId: 'player', playerName: 'Player', position: 'PG',
        eligiblePositions: ['PG'], nbaId: null, transactionType, occurredAt: '2026-11-10T12:00:00Z',
    }
    let screen!: ReactTestRenderer
    let row!: ReactTestRenderer
    push.mockClear()
    try {
        await act(async () => { screen = create(React.createElement(ActivityFeed, { transactions: [item] })) })
        const renderItem = screen.root.findByType('FlashList' as React.ElementType).props.renderItem
        await act(async () => { row = create(renderItem({ item })) })
        const links = row.root.findAllByType('Pressable' as React.ElementType)
        expect(links).toHaveLength(transactionType === 'fa_add' ? 0 : 1)
        if (links.length) {
            expect(links[0].props.accessibilityLabel).toBe('View Player stats')
            await act(async () => links[0].props.onPress())
            expect(push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/player/[id]', params: expect.objectContaining({ id: 'player' }) }))
        }
    } finally {
        if (row) await act(async () => row.unmount())
        if (screen) await act(async () => screen.unmount())
    }
})

import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { ActivityFeed } from '@/components/league/LeagueActivityFeed'
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

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

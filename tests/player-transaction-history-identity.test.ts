import React from 'react'
import { Pressable, Text } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import type { TransactionHistoryEntry } from '@/lib/players'

const getPlayerTransactionHistory = vi.hoisted(() => vi.fn())

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    View: 'View',
}))
vi.mock('@/lib/players', () => ({ getPlayerTransactionHistory }))
vi.mock('@/constants/tokens', () => ({
    colors: { textPrimary: '#000', textPlaceholder: '#777', separator: '#ddd', textMuted: '#666', primaryDark: '#111' },
    fontSize: { md: 14, sm: 12 },
    fontWeight: { bold: '700', semibold: '600' },
    spacing: { md: 12, xxs: 2, lg: 16 },
    radii: { md: 4 },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const transaction = (id: string, label: string): TransactionHistoryEntry => ({
    id,
    transactionType: 'trade',
    label,
    teamName: `${label} Team`,
    occurredAt: '2026-07-09T10:00:00Z',
})

const page = (prefix: string) => Array.from({ length: 20 }, (_, index) => transaction(`${prefix}-${index}`, `${prefix} ${index}`))

describe('player transaction history identity', () => {
    it('switches cached identities synchronously and ignores stale pagination', async () => {
        let resolvePage!: (value: TransactionHistoryEntry[]) => void
        const pending = new Promise<TransactionHistoryEntry[]>((resolve) => { resolvePage = resolve })
        getPlayerTransactionHistory.mockReturnValue(pending)
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(TransactionHistory, {
                playerId: 'player-a', leagueId: 'league-a', transactions: page('Alpha'),
            }))
        })
        const loadMore = renderer.root.findByType(Pressable)
        await act(async () => { void loadMore.props.onPress(); await Promise.resolve() })

        await act(async () => {
            renderer.update(React.createElement(TransactionHistory, {
                playerId: 'player-b', leagueId: 'league-b', transactions: [transaction('bravo', 'Bravo')],
            }))
        })
        const visibleText = () => renderer.root.findAllByType(Text).map((node) => node.props.children).flat().join(' ')
        expect(visibleText()).toContain('Bravo')
        expect(visibleText()).not.toContain('Alpha')

        await act(async () => { resolvePage([transaction('stale', 'Stale Alpha')]); await pending })
        expect(visibleText()).toContain('Bravo')
        expect(visibleText()).not.toContain('Stale Alpha')
        await act(async () => { renderer.unmount() })
    })
})

import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { AuctionIdlePanel } from '@/components/league/draft-room/AuctionIdlePanel'
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput',
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable' }))
vi.mock('@/lib/draft', () => ({ NOMINATION_ORDER_MODE_LABELS: { user_nominated: "Manager's choice" } }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => undefined }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps the nomination hint through first connection and reports a later connection loss', async () => {
    const controller = {
        state: { draft: { status: 'in_progress', nominationOrderMode: 'user_nominated' }, order: [], currentNominatorMemberId: 'me' },
        realtimeConnected: false, actionsReady: false, nominating: false, setNominating: vi.fn(), loadError: null,
    } as unknown as React.ComponentProps<typeof AuctionIdlePanel>['controller']
    const tree = () => React.createElement(AuctionIdlePanel, { controller: { ...controller }, memberId: 'me', compact: false })
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(tree()) })
    const text = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    try {
        const first = text()
        expect(first).toContain("Nomination order: Manager's choice")
        expect(first).not.toContain('Reconnecting live draft. Nominations stay disabled.')
        controller.realtimeConnected = true
        await act(async () => screen.update(tree()))
        expect(text()).toEqual(first)
        controller.realtimeConnected = false
        await act(async () => screen.update(tree()))
        expect(text()).toContain('Reconnecting live draft. Nominations stay disabled.')
    } finally { await act(async () => screen.unmount()) }
})

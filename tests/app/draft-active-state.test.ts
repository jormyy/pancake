import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { ActiveDraftEntry } from '@/components/league/DraftActiveState'
import type { Draft } from '@/lib/draft'

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 393, height: 852 }), StyleSheet: { create: (value: unknown) => value },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const draft = (status: string): Draft => ({
    id: 'draft', leagueId: 'league', status, draftType: 'snake', isMock: false, currentNominationOrder: 0, nominationOrderMode: 'user_nominated',
    budgetPerTeam: null, scheduledAt: null, roomName: null, createdByMemberId: null, pickTimerSeconds: 60, timerExpiryBehavior: 'auto_pick',
    rounds: 3, startedAt: null, pauseReason: null, pausedAt: null, pausedRemainingSeconds: null,
})

it.each([
    ['pending', 'drafting', 'Upcoming Draft', 'Join Rookie Draft'],
    ['in_progress', 'drafting', 'Live Draft', 'Join Rookie Draft'],
    ['paused', 'drafting', 'Live Draft', 'Resume Rookie Draft'],
    ['completed', 'drafting', 'Draft Results', 'Resolve Rookie Draft'],
    ['completed', 'active', 'Draft Results', 'View Rookie Draft Results'],
] as const)('names a %s rookie draft in a %s league', async (status, leagueStatus, title, action) => {
    let card!: ReactTestRenderer
    await act(async () => {
        card = create(React.createElement(ActiveDraftEntry, {
            activeDraft: draft(status), activeDraftLoading: false, leagueStatus, isCommissioner: false, draftLoading: false,
            onJoinDraft: vi.fn(), onReseedRookiePicks: vi.fn(),
        }))
    })
    try {
        const texts = card.root.findAllByType('Text' as React.ElementType).map((node) => node.props.children)
        expect(texts[0]).toBe(title)
        expect(card.root.findByType('Pressable' as React.ElementType).props.accessibilityLabel).toBe(action)
    } finally { await act(async () => card.unmount()) }
})

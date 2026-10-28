import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { OtherMatchups } from '@/components/OtherMatchups'
import type { LeagueWeekMatchup } from '@/lib/scoring'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/lib/format', () => ({ formatPoints: (value: number | null) => String(value ?? 0) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const other: LeagueWeekMatchup = { id: 'other', homeMemberId: 'a', awayMemberId: 'b', homeTeamName: 'Owls', awayTeamName: 'Foxes', homePoints: 102, awayPoints: 97, isMine: false, isFinalized: false }
afterEach(async () => { await act(async () => screen?.unmount()) })
it('shows both teams and scores, excludes the own matchup, and opens the selected matchup', async () => {
    const open = vi.fn()
    await act(async () => { screen = create(React.createElement(OtherMatchups, { matchups: [{ ...other, id: 'own', isMine: true }, other], onOpen: open })) })
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(text).toEqual(['Other matchups', 'Owls', '102', 'Foxes', '97'])
    const entries = screen.root.findAllByType('Pressable' as React.ElementType)
    expect(entries).toHaveLength(1)
    await act(async () => entries[0].props.onPress())
    expect(open).toHaveBeenCalledExactlyOnceWith('other')
})
it('omits the strip when no other matchup exists', async () => {
    await act(async () => { screen = create(React.createElement(OtherMatchups, { matchups: [{ ...other, isMine: true }], onOpen: vi.fn() })) })
    expect(screen.toJSON()).toBeNull()
})

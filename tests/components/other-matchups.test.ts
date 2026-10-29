import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { OtherMatchups } from '@/components/OtherMatchups'
import type { LeagueWeekMatchup } from '@/lib/scoring'
import { borderWidth, colors } from '@/constants/tokens'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/lib/format', () => ({ formatPoints: (value: number | null) => String(value ?? 0) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const other: LeagueWeekMatchup = { id: 'other', homeMemberId: 'a', awayMemberId: 'b', homeTeamName: 'Owls', awayTeamName: 'Foxes', homePoints: 102, awayPoints: 97, isMine: false, isFinalized: false }
afterEach(async () => { await act(async () => screen?.unmount()) })
it('puts the own matchup first and opens it directly', async () => {
    const open = vi.fn()
    await act(async () => { screen = create(React.createElement(OtherMatchups, { matchups: [other, { ...other, id: 'own', isMine: true }], onOpen: open })) })
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(text).toEqual(['Other matchups', 'Owls', '102', 'Foxes', '97', 'Owls', '102', 'Foxes', '97'])
    const entries = screen.root.findAllByType('Pressable' as React.ElementType)
    expect(entries).toHaveLength(2)
    expect(entries[0].props.accessibilityState.selected).toBe(true)
    await act(async () => entries[0].props.onPress())
    expect(open).toHaveBeenCalledExactlyOnceWith('own')
})
it('keeps the own matchup selectable when it is the only matchup', async () => {
    await act(async () => { screen = create(React.createElement(OtherMatchups, { matchups: [{ ...other, isMine: true }], onOpen: vi.fn() })) })
    expect(screen.root.findAllByType('Pressable' as React.ElementType)).toHaveLength(1)
})

it('moves the current outline to another matchup while keeping the viewer first', async () => {
    await act(async () => { screen = create(React.createElement(OtherMatchups, {
        matchups: [other, { ...other, id: 'own', isMine: true }], currentMatchupId: 'other', onOpen: vi.fn(),
    })) })
    const entries = screen.root.findAllByType('Pressable' as React.ElementType)
    expect(entries.map(entry => entry.props.accessibilityState.selected)).toEqual([false, true])
    expect(Object.assign({}, ...entries[1].props.style.filter(Boolean))).toMatchObject({ borderWidth: borderWidth.strong, borderColor: colors.primary })
})

it('outlines only the current matchup and keeps it visible when it belongs to the viewer', async () => {
    await act(async () => { screen = create(React.createElement(OtherMatchups, {
        matchups: [{ ...other, id: 'own', isMine: true }, other], currentMatchupId: 'own', onOpen: vi.fn(),
    })) })
    const entries = screen.root.findAllByType('Pressable' as React.ElementType)
    expect(entries).toHaveLength(2)
    expect(entries[0].props.accessibilityState).toEqual({ selected: true })
    expect(Object.assign({}, ...entries[0].props.style.filter(Boolean))).toMatchObject({ borderWidth: borderWidth.strong, borderColor: colors.primary })
    expect(entries[1].props.accessibilityState).toEqual({ selected: false })
    expect(Object.assign({}, ...entries[1].props.style.filter(Boolean))).toMatchObject({ borderWidth: borderWidth.thin, borderColor: colors.border })
})

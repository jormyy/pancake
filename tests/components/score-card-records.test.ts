import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { ScoreCard } from '@/components/ScoreCard'
import type { Matchup } from '@/lib/scoring'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/components/ui/Badge', () => ({ Badge: 'Badge' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('keeps each team record beside its name and score', async () => {
    const matchup = { myTeamName: 'Mine', opponentTeamName: 'Other', myWins: 0, myLosses: 0, opponentWins: 1, opponentLosses: 2, myPoints: 123, opponentPoints: 117, weekNumber: 2 } as Matchup
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(ScoreCard, { matchup, compact: true })) })
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children).flat().join(' ')
    expect(text).toContain('0-0')
    expect(text).toContain('1-2')
    await act(async () => screen.unmount())
})

it('places accessible 44px navigation targets outside the team identity blocks', async () => {
    const { controlSize } = await import('@/constants/tokens')
    const previous = vi.fn(), next = vi.fn()
    const matchup = { myTeamName: 'Mine', opponentTeamName: 'Other', weekNumber: 2 } as Matchup
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(ScoreCard, { matchup, onPreviousMatchup: previous, onNextMatchup: next })) })
    const buttons = screen.root.findAllByType('Pressable' as React.ElementType)
    expect(buttons.map(button => button.props.accessibilityLabel)).toEqual(['Previous matchup', 'Next matchup'])
    expect(buttons.map(button => button.props.style.width)).toEqual([controlSize.minTouch, controlSize.minTouch])
    expect(buttons.map(button => button.props.style.minHeight)).toEqual([controlSize.minTouch, controlSize.minTouch])
    expect(buttons[0].parent!.children.map(child => typeof child === 'string' ? child : child.props.testID ?? child.props.accessibilityLabel)).toEqual(['Previous matchup', 'matchup-team-left', 'matchup-team-right', 'Next matchup'])
    await act(async () => { buttons[0].props.onPress(); buttons[1].props.onPress() })
    expect(previous).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledOnce()
    await act(async () => screen.unmount())
})

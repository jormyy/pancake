import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { ScoreCard } from '@/components/ScoreCard'
import type { Matchup } from '@/lib/scoring'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value } }))
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

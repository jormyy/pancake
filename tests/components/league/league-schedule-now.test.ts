import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { LeagueSchedule } from '@/components/league/LeagueSchedule'
import type { LeagueScheduleRow } from '@/lib/cache/view-types'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/components/ui/ListHeader', () => ({ ListHeader: 'View' }))
vi.mock('@/components/ui/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/ui', () => ({ usePageMetrics: () => ({ padX: 12 }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'Pressable' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function flatStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return style.reduce<Record<string, unknown>>((acc, part) => ({ ...acc, ...flatStyle(part) }), {})
    return (typeof style === 'object' && style !== null ? style : {}) as Record<string, unknown>
}

const rows = [
    { weekNumber: 3, matchupId: 'matchup-3', opponentTeamName: 'Cedar Owls', isCurrent: true, status: 'live', myPoints: 123, opponentPoints: 117 },
    { weekNumber: 4, matchupId: null, opponentTeamName: null, isCurrent: false, status: 'upcoming', myPoints: null, opponentPoints: null },
] as LeagueScheduleRow[]

it('keeps each week on one line with the Now marker beside the opponent', async () => {
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(LeagueSchedule, { rows })) })
    try {
        const row = screen.root.findAll(node => node.props.role === 'listitem')[0]
        expect(row.props.style).toContainEqual(expect.objectContaining({ flexDirection: 'row', alignItems: 'center' }))
        const badge = row.findByType('Badge' as React.ElementType)
        const opponentCell = badge.parent!
        expect(opponentCell.props.style).toMatchObject({ flexDirection: 'row', alignItems: 'center' })
        expect(opponentCell.findAllByType('Text' as React.ElementType).map(node => node.children.join(''))).toEqual(['Cedar Owls'])
        expect(row.findAllByType('Text' as React.ElementType).map(node => node.children.join(''))).toEqual(['3', 'Cedar Owls', 'Live', '123', '117'])
    } finally {
        await act(async () => screen.unmount())
    }
})

it('truncates a 30-character opponent name on one row at phone width', async () => {
    const longRows = [{ weekNumber: 5, matchupId: 'matchup-5', opponentTeamName: 'Dickenballs Dynasty Squad XXIV', isCurrent: true, status: 'win', myPoints: 123, opponentPoints: 117 }] as LeagueScheduleRow[]
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(LeagueSchedule, { rows: longRows })) })
    try {
        const row = screen.root.findAll(node => node.props.role === 'listitem')[0]
        expect(flatStyle(row.props.style).flexWrap).toBeUndefined()
        const name = row.findAllByType('Text' as React.ElementType)[1]
        expect(name.children.join('')).toBe('Dickenballs Dynasty Squad XXIV')
        expect(name.props.numberOfLines).toBe(1)
        expect(flatStyle(name.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 })
        expect(row.findAllByType('Badge' as React.ElementType)).toHaveLength(1)
        expect(row.findAllByType('Text' as React.ElementType).map(node => node.children.join(''))).toEqual(['5', 'Dickenballs Dynasty Squad XXIV', 'W', '123', '117'])
    } finally {
        await act(async () => screen.unmount())
    }
})

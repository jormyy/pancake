import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { LeagueSchedule } from '@/components/league/LeagueSchedule'
import snapshot from '@/tests/fixtures/league-schedule.json'
import type { LeagueScheduleRow } from '@/lib/cache/view-types'
import { colors } from '@/constants/tokens'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/components/ui/ListHeader', () => ({ ListHeader: 'View' }))
vi.mock('@/components/ui', () => ({ usePageMetrics: () => ({ padX: 12 }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('renders ordered weeks, skipped weeks, scores, current state, and undecided playoffs from the SQL snapshot', async () => {
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(LeagueSchedule, { rows: snapshot as LeagueScheduleRow[] })) })
    const rows = screen.root.findAll(node => node.props.role === 'listitem')
    expect(rows).toHaveLength(20)
    expect(rows.map(row => row.props['aria-label'])).toEqual(snapshot.map(row => {
        if (row.status === 'skipped') return `Week ${row.weekNumber}, skipped`
        const result = row.status === 'win' ? `W ${row.myPoints}–${row.opponentPoints}` : row.status === 'loss' ? `L ${row.myPoints}–${row.opponentPoints}` : row.status === 'tie' ? `T ${row.myPoints}–${row.opponentPoints}` : row.status === 'live' ? `Live ${row.myPoints}–${row.opponentPoints}` : row.status === 'playoffs' ? 'Playoffs' : 'Upcoming'
        return `Week ${row.weekNumber}${row.isCurrent ? ', current week' : ''}${row.opponentTeamName ? `, ${row.opponentTeamName}` : ''}, ${result}`
    }))
    expect(rows[0].findAllByType('Text' as React.ElementType).map(node => node.children.join(''))).toEqual(['1', 'No matchup', 'Skipped'])
    expect(rows[0].findAllByType('Text' as React.ElementType)[1].props.style).toContainEqual({ color: colors.textMuted })
    expect(rows[4].props.style.at(-1)).toBeTruthy()
    expect(rows[5].props.style.at(-1)).toBe(false)
    expect(rows[16].props['aria-label']).not.toContain('Cedar Owls')
    await act(async () => screen.unmount())
})

it('keeps missing regular matchups pending or upcoming and playoff placeholders unchanged', async () => {
    const rows: LeagueScheduleRow[] = ['pending', 'upcoming', 'playoffs'].map((status, index) => ({
        weekNumber: index + 1, opponentTeamName: null, isCurrent: false, status: status as LeagueScheduleRow['status'], myPoints: null, opponentPoints: null,
    }))
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(LeagueSchedule, { rows })) })
    const items = screen.root.findAll(node => node.props.role === 'listitem')
    expect(items.map(row => row.props['aria-label'])).toEqual(['Week 1, Pending', 'Week 2, Upcoming', 'Week 3, Playoffs'])
    expect(items.map(row => row.findAllByType('Text' as React.ElementType).map(node => node.children.join('')))).toEqual([
        ['1', 'To be decided', 'Pending'], ['2', 'To be decided', 'Upcoming'], ['3', '—', 'Playoffs'],
    ])
    await act(async () => screen.unmount())
})

it('announces a current skipped week without a matchup or score', async () => {
    const rows: LeagueScheduleRow[] = [{ weekNumber: 5, opponentTeamName: null, isCurrent: true, status: 'skipped', myPoints: null, opponentPoints: null }]
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(LeagueSchedule, { rows })) })
    const row = screen.root.find(node => node.props.role === 'listitem')
    expect(row.props['aria-label']).toBe('Week 5, skipped')
    expect(row.props.accessibilityLabel).toBe('Week 5, skipped')
    expect(row.findAllByType('Text' as React.ElementType).map(node => node.children.join(''))).toEqual(['5', 'Current', 'No matchup', 'Skipped'])
    await act(async () => screen.unmount())
})

it('shows an empty state before a season calendar exists', async () => {
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(LeagueSchedule, { rows: [] })) })
    expect(screen.root.findByType('EmptyState' as React.ElementType).props.message).toBe('No schedule yet.')
    await act(async () => screen.unmount())
})

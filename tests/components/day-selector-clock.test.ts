import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { DaySelector } from '@/components/DaySelector'
import { spacing } from '@/constants/tokens'
import { getWeekDays } from '@/lib/lineup/read'

const fixture = vi.hoisted(() => ({ dates: [] as string[] }))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles } }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'Cell' }))
vi.mock('@/lib/shared/week', () => ({ getSeasonWeekDates: async () => fixture.dates }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => {
    const query = {
        select: () => query, eq: () => query, gte: () => query,
        lte: async () => ({ data: fixture.dates.map(date => ({ game_date: date, home_team: 'BOS', away_team: 'NYK' })), error: null }),
    }
    return query
} } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
const cell = (label: string) => screen.root.findAllByType('Cell' as React.ElementType)
    .find(node => node.props.accessibilityLabel.includes(label))!
const indicator = (label: string, width: number, height: number) => cell(label).findAllByType('View' as React.ElementType)
    .some(node => [node.props.style].flat(2).some(style => style?.width === width && style?.height === height))
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers() })

it.each([
    ['2026-10-20T03:59:59Z', '2026-10-20T04:00:01Z', '2026-10-19', '2026-10-20', 'October 19', 'October 20'],
    ['2026-11-02T04:59:59Z', '2026-11-02T05:00:01Z', '2026-11-01', '2026-11-02', 'November 1', 'November 2'],
])('keeps today and past indicators consistent across the ET boundary at %s', async (before, after, oldDate, newDate, oldLabel, newLabel) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(before))
    fixture.dates = [oldDate, newDate]
    const days = await getWeekDays(1, 2026)
    const render = (value = days) => React.createElement(DaySelector, { days: value, selectedDate: '2099-01-01', onSelect: () => {} })
    await act(async () => { screen = create(render()) })
    expect(indicator(oldLabel, 5, 5)).toBe(true)
    vi.setSystemTime(new Date(after))
    await act(async () => screen.update(render()))
    const withoutResourceReload = { oldToday: indicator(oldLabel, 5, 5), newToday: indicator(newLabel, 5, 5) }
    const refreshed = await getWeekDays(1, 2026)
    await act(async () => screen.update(render(refreshed)))
    expect(withoutResourceReload).toEqual({ oldToday: false, newToday: true })
    expect(indicator(oldLabel, 5, 5)).toBe(false)
    expect(indicator(newLabel, 5, 5)).toBe(true)
    expect(indicator(oldLabel, spacing.lg, spacing.xxs)).toBe(true)
})

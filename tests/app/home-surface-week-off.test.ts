import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WeekOffNotice } from '@/components/WeekOffNotice'

const mocks = vi.hoisted(() => ({ from: vi.fn(), cached: vi.fn(), write: vi.fn() }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/ui/Card', () => ({ Card: 'Card' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from } }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: mocks.cached, writePersistentCache: mocks.write }))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: async () => 1 }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-24' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
beforeEach(() => { vi.clearAllMocks(); mocks.cached.mockReturnValue(undefined) })
afterEach(async () => { await act(async () => screen?.unmount()) })
const mount = async () => { await act(async () => { screen = create(React.createElement(WeekOffNotice, { leagueId: 'league', onBrowse: vi.fn() })) }) }
const cards = () => screen.root.findAllByType('Card' as React.ElementType)
const heading = () => screen.root.findByProps({ role: 'heading' }).props.children
const query = (result: Promise<unknown>) => {
    const builder = { select: () => builder, eq: () => builder, lte: () => builder, gte: () => builder, maybeSingle: () => result }
    return builder
}

it('shows the week-off reason with the first card', async () => {
    let finish!: (value: unknown) => void
    const season = new Promise(resolve => { finish = resolve })
    mocks.from.mockReturnValueOnce(query(season))
    await mount()
    expect(cards()).toHaveLength(0)
    await act(async () => finish({ data: { id: 'season', season_year: 2027, skipped_weeks: [1] } }))
    expect(cards()).toHaveLength(1)
    expect(heading()).toBe('Skipped week')
})

it('shows the confirmed empty state when its reason read fails', async () => {
    mocks.from.mockReturnValue(query(Promise.resolve({ data: null, error: new Error('offline') })))
    await mount()
    expect(cards()).toHaveLength(1)
    expect(heading()).toBe('No matchup this week')
})

it('shows a fresh saved reason without another request', async () => {
    mocks.cached.mockReturnValue({ day: '2026-10-24', reason: 'Bye', savedAt: Date.now() })
    await mount()
    expect(heading()).toBe('Bye week')
    expect(mocks.from).not.toHaveBeenCalled()
})

it('keeps the current league reason when a former league read finishes late', async () => {
    let finish!: (value: unknown) => void
    mocks.from.mockReturnValueOnce(query(new Promise(resolve => { finish = resolve })))
    mocks.from.mockReturnValueOnce(query(Promise.resolve({ data: { id: 'new', season_year: 2027, skipped_weeks: [1] } })))
    await mount()
    await act(async () => screen.update(React.createElement(WeekOffNotice, { leagueId: 'new', onBrowse: vi.fn() })))
    expect(heading()).toBe('Skipped week')
    await act(async () => finish({ data: { id: 'old', season_year: 2027, skipped_weeks: [] } }))
    expect(heading()).toBe('Skipped week')
})

it('opens Players from the notice', async () => {
    const browse = vi.fn()
    mocks.cached.mockReturnValue({ day: '2026-10-24', reason: null, savedAt: Date.now() })
    await act(async () => { screen = create(React.createElement(WeekOffNotice, { leagueId: 'league', onBrowse: browse })) })
    await act(async () => screen.root.findByType('Button' as React.ElementType).props.onPress())
    expect(browse).toHaveBeenCalledOnce()
})

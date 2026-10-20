import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WeekOffNotice } from '@/components/WeekOffNotice'

const state = vi.hoisted(() => ({ cache: new Map<string, unknown>(), frames: [] as { message: string; reserveCopy: { message: string; description: string } }[], rows: new Map<string, unknown>(), reads: vi.fn() }))
vi.mock('@/components/EmptyState', async () => {
    const { createElement } = await import('react')
    return { EmptyState: (props: { message: string; reserveCopy: { message: string; description: string } }) => {
        state.frames.push(props)
        return createElement('empty', props)
    } }
})
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: (key: string) => state.cache.get(key), writePersistentCache: (key: string, value: unknown) => state.cache.set(key, value) }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: (table: string) => {
    state.reads(table)
    const query = { select: () => query, eq: () => query, lte: () => query, gte: () => query,
        maybeSingle: () => Promise.resolve(state.rows.get(table)),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(state.rows.get(table)).then(resolve) }
    return query
} } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const browse = vi.fn()
const mount = async (leagueId = 'league') => { await act(async () => { screen = create(React.createElement(WeekOffNotice, { leagueId, onBrowse: browse })) }) }
beforeEach(() => { state.cache.clear(); state.frames = []; state.reads.mockClear(); browse.mockClear() })
afterEach(async () => { await act(async () => screen?.unmount()) })
it.each(['Skipped', 'Bye', null])('reserves identical copy space and paints the cached %s reason first on return', async reason => {
    state.rows.set('league_seasons', { data: { id: 'season', season_year: 2027, skipped_weeks: reason === 'Skipped' ? [1] : [] } })
    state.rows.set('season_weeks', { data: { week_number: 1 } })
    state.rows.set('matchups', { count: reason === 'Bye' ? 2 : 0 })
    await mount()
    const expected = reason ? `${reason} week` : 'No matchup this week yet'
    expect(state.frames.at(-1)?.message).toBe(expected)
    expect(state.frames.every(frame => frame.reserveCopy)).toBe(true)
    await act(async () => screen.unmount())
    const reads = state.reads.mock.calls.length
    state.frames = []
    await mount()
    expect(state.frames.map(frame => frame.message)).toEqual([expected])
    expect(state.reads).toHaveBeenCalledTimes(reads)
    await act(async () => screen.root.findByType('empty' as React.ElementType).props.onAction())
    expect(browse).toHaveBeenCalledOnce()
})
it('does not let a former league change the current notice reason', async () => {
    let finish!: (value: unknown) => void
    state.rows.set('league_seasons', new Promise(resolve => { finish = resolve }))
    await mount('old')
    state.rows.set('league_seasons', { data: { id: 'new', season_year: 2027, skipped_weeks: [1] } })
    state.rows.set('season_weeks', { data: { week_number: 1 } })
    await act(async () => screen.update(React.createElement(WeekOffNotice, { leagueId: 'new', onBrowse: browse })))
    expect(state.frames.at(-1)?.message).toBe('Skipped week')
    await act(async () => finish({ data: { id: 'old', season_year: 2027, skipped_weeks: [] } }))
    expect(state.frames.at(-1)?.message).toBe('Skipped week')
})

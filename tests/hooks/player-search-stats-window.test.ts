import { boundary, held } from '../helpers/screen-view-boundary'
import { searchHarness, searchPayload } from '../helpers/search-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = searchHarness()
beforeEach(() => { boundary.read.mockResolvedValue(searchPayload()) })

it('keeps season defaults and sends the selected window on every sorted page', async () => {
    await h.render()
    expect(boundary.read.mock.calls.at(-1)?.[0].params).not.toHaveProperty('statsDays')
    boundary.read.mockResolvedValue(searchPayload(['seven'], true))
    await act(async () => { h.latest.statsWindow.setDays(7); h.latest.sort.setMode('pts'); h.latest.sort.setDir('asc') })
    expect(boundary.read.mock.calls.at(-1)?.[0].params).toMatchObject({ statsDays: 7, sortBy: 'pts', sortDir: 'asc' })
    expect(h.latest.activeFilterCount).toBe(1)
    await act(async () => { await h.latest.results.loadMore() })
    expect(boundary.read.mock.calls.at(-1)?.[0].params).toMatchObject({ statsDays: 7, offset: 1 })
    await act(async () => { h.latest.clearAllFilters() })
    expect(h.latest.statsWindow.days).toBeNull()
    expect(h.latest.activeFilterCount).toBe(0)
    expect(h.latest.results.players.map(player => player.id)).toEqual(['player'])
    await act(async () => { await h.latest.refresh(true) })
    expect(boundary.read.mock.calls.at(-1)?.[0].params).not.toHaveProperty('statsDays')
})

it('rejects an older page after switching from seven to fifteen days', async () => {
    await h.render()
    boundary.read.mockResolvedValue(searchPayload(['seven'], true))
    await act(async () => { h.latest.statsWindow.setDays(7) })
    const old = held<ReturnType<typeof searchPayload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(searchPayload(['fifteen']))
    let request!: Promise<void>
    await act(async () => { request = h.latest.results.loadMore() })
    await act(async () => { h.latest.statsWindow.setDays(15) })
    expect(h.latest.results.players.map(player => player.id)).toEqual(['fifteen'])
    await act(async () => { old.resolve(searchPayload(['old-page'])); await request })
    expect(h.latest.results.players.map(player => player.id)).toEqual(['fifteen'])
})

it('does not replace window averages with season totals', async () => {
    const payload = searchPayload()
    payload.players[0].avg_points = 12
    boundary.read.mockResolvedValue({ ...payload, visibleTotals: [{ player_id: 'player', totals: { games_played: 20, points: 2000, points_count: 20 } }] })
    await h.render()
    expect(h.latest.results.players[0].avg_points).toBe(100)
    await act(async () => { h.latest.statsWindow.setDays(7) })
    expect(h.latest.results.players[0].avg_points).toBe(12)
    await act(async () => { h.latest.statsWindow.setDays(null) })
    expect(h.latest.results.players[0].avg_points).toBe(100)
})

it('uses the Eastern date at midnight across the DST change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T04:59:59Z'))
    await h.render()
    await act(async () => { h.latest.statsWindow.setDays(15) })
    expect(boundary.read.mock.calls.at(-1)?.[0].params.statsDate).toBe('2026-11-01')
    vi.setSystemTime(new Date('2026-11-02T05:00:00Z'))
    await h.render()
    expect(boundary.read.mock.calls.at(-1)?.[0].params).toMatchObject({ statsDays: 15, statsDate: '2026-11-02' })
})

it('exposes read failure without falling back to season data', async () => {
    await h.render()
    boundary.read.mockRejectedValue(new Error('stats unavailable'))
    await act(async () => { h.latest.statsWindow.setDays(7) })
    expect(h.latest.results.players).toEqual([])
    expect(h.latest.results.error?.message).toBe('stats unavailable')
})

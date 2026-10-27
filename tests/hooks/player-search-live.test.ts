import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { searchHarness, searchPayload } from '../helpers/search-view-fixture'
import { act, create } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'
import { useVisiblePlayerRows } from '@/hooks/use-player-search'
import React from 'react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = searchHarness()
const totals = (points = 22, status = 'Final') => ({ ...searchPayload(['a', 'b', 'offscreen']), visibleTotals: [{ player_id: 'a', totals: { points, points_count: 2, games_played: 2 }, rounded_fantasy_average: null, game_status: status, game_time: null, started_at: null }] })
beforeEach(() => { boundary.read.mockResolvedValue(totals()) })
it('uses totals from the page without another visible-row read', async () => {
    await h.render()
    expect(h.latest.results.players[0].avg_fantasy_points).toBe(11)
    let rows!: ReturnType<typeof useVisiblePlayerRows>
    const Probe = () => { rows = useVisiblePlayerRows(h.latest.results.players, 'league', 2027, { points: 1 }, { enabled: true, ownerKey: 'account' }); return null }
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => { rows.onViewableItemsChanged({ viewableItems: h.latest.results.players.map(item => ({ item, isViewable: true })) }) })
    expect(rows.rows.map(row => row.id)).toEqual(['a', 'b', 'offscreen'])
    expect(boundary.read).toHaveBeenCalledOnce()
    await act(async () => screen.unmount())
})
it.each(['stat', 'player_stats', 'score', 'game'])('updates totals on a %s version and preserves row order', async topic => {
    await h.render(); boundary.read.mockResolvedValue(totals(30))
    await act(async () => bumpView('league', topic))
    expect(h.latest.results.players[0].avg_fantasy_points).toBe(15)
    expect(h.latest.results.players.map(row => row.id)).toEqual(['a', 'b', 'offscreen'])
})
it('pauses hidden reads and catches up on return', async () => {
    await h.render(); boundary.hidden = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); bumpView('league', 'stat') })
    expect(boundary.read).toHaveBeenCalledOnce()
    boundary.hidden = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(boundary.read).toHaveBeenCalledTimes(2)
})
it('pauses an inactive tab', async () => {
    await h.render({ enabled: false }); await act(async () => bumpView('league', 'stat'))
    expect(boundary.read).not.toHaveBeenCalled()
})
it('keeps the last numbers during refresh and rejects a previous member response', async () => {
    await h.render(); const old = held<ReturnType<typeof totals>>()
    boundary.read.mockReturnValueOnce(old.promise)
    await act(async () => bumpView('league', 'stat'))
    expect(h.latest.results.players[0].avg_fantasy_points).toBe(11)
    boundary.read.mockResolvedValue(totals(30)); await h.render({ member: 'other' })
    await act(async () => old.resolve(totals(999)))
    expect(h.latest.results.players[0].avg_fantasy_points).toBe(15)
})
it.each(['InProgress', 'Final'])('accepts a %s game from the atomic page', async status => {
    boundary.read.mockResolvedValue(totals(22, status)); await h.render()
    expect(h.latest.results.players[0].playing_now).toBe(status === 'InProgress')
})
it('keeps fallback averages when the view contains no current live totals', async () => {
    const payload = searchPayload(); payload.players[0].avg_fantasy_points = 14
    boundary.read.mockResolvedValue(payload); await h.render()
    expect(h.latest.results.players[0].avg_fantasy_points).toBe(14)
    expect(boundary.read).toHaveBeenCalledOnce()
})

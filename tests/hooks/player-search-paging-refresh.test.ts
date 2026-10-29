import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { searchHarness, searchPayload } from '../helpers/search-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'
import { cachedScreenView, saveScreenView } from '@/lib/cache/screen-cache'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = searchHarness()
let revision = 1
const page = (offset = 0) => {
    const payload = searchPayload(Array.from({ length: 20 }, (_, index) => `player-${offset + index}`), offset < 80)
    payload.players.forEach(player => { player.avg_points = revision })
    return payload
}
const ids = () => h.latest.results.players.map(player => player.id)
const loadThree = async () => {
    await h.render()
    await act(async () => { await h.latest.results.loadMore() })
    await act(async () => { await h.latest.results.loadMore() })
    expect(ids()).toHaveLength(60)
}
beforeEach(() => {
    revision = 1
    boundary.read.mockImplementation(async scope => page(Number(scope.params.offset ?? 0)))
})
it.each(['stat', 'player_stats', 'roster', 'catchup'])('refreshes every loaded page after %s without shrinking any frame', async topic => {
    await loadThree()
    const previous = ids()
    h.frames.length = 0
    revision = 2
    await act(async () => bumpView('league', topic))
    expect(ids()).toEqual(previous)
    expect(h.frames.every(frame => frame.results.players.length >= 60)).toBe(true)
    expect(h.latest.results.players.every(player => player.avg_points === 2)).toBe(true)
    expect(boundary.read.mock.calls.slice(3).map(([scope]) => scope.params.offset ?? 0)).toEqual([0, 20, 40])
})
it.each(['focus', 'network', 'visibility'])('keeps all loaded pages through a %s round trip', async event => {
    await loadThree()
    const previous = ids()
    if (event === 'focus') { boundary.focused = false; await h.render(); boundary.focused = true; await h.render() }
    if (event === 'network') { boundary.online = false; await h.render(); boundary.online = true; await h.render() }
    if (event === 'visibility') {
        boundary.hidden = true; await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        boundary.hidden = false; await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    }
    expect(ids()).toEqual(previous)
})
it.each(['page-first', 'refresh-first'])('retains a loadMore racing refresh when %s completes', async order => {
    await loadThree()
    const next = held<ReturnType<typeof page>>()
    const fresh = held<ReturnType<typeof page>>()
    boundary.read.mockImplementation(async scope => Number(scope.params.offset ?? 0) === 60 ? next.promise : Number(scope.params.offset ?? 0) === 0 ? fresh.promise : page(Number(scope.params.offset)))
    let loading!: Promise<void>
    await act(async () => { loading = h.latest.results.loadMore() })
    await act(async () => bumpView('league', 'stat'))
    if (order === 'page-first') {
        await act(async () => { next.resolve(page(60)); await loading })
        await act(async () => fresh.resolve(page()))
    } else {
        await act(async () => fresh.resolve(page()))
        await act(async () => { next.resolve(page(60)); await loading })
    }
    expect(ids()).toEqual(Array.from({ length: 80 }, (_, index) => `player-${index}`))
    expect(new Set(ids()).size).toBe(80)
})
it('keeps the loaded window in the cache across a remount', async () => {
    await loadThree()
    const previous = ids()
    await h.unmount(); await h.render()
    expect(ids()).toEqual(previous)
})
it('keeps extra pages while a replacement cache page revalidates', async () => {
    await loadThree()
    const scope = boundary.read.mock.calls[0][0]
    const selected = { ...scope, accountId: 'account', screen: 'players' as const }
    const current = cachedScreenView(selected)
    expect(current?.value).toBeDefined()
    revision = 5
    await act(async () => saveScreenView(selected, { ...page(), players: page().players.map(player => ({ ...player, avg_points: 5 })) }, boundary.version))
    expect(ids()).toHaveLength(60)
    expect(h.latest.results.players[0].avg_points).toBe(5)
})
it('keeps rows and the loaded range after a tail refresh fails, then retries it', async () => {
    await loadThree()
    boundary.read.mockImplementation(async scope => {
        if (scope.params.offset === 20) throw new Error('tail failed')
        return page(Number(scope.params.offset ?? 0))
    })
    await act(async () => bumpView('league', 'stat'))
    expect(ids()).toHaveLength(60)
    expect(h.latest.results.error?.message).toBe('tail failed')
    boundary.read.mockImplementation(async scope => page(Number(scope.params.offset ?? 0)))
    await act(async () => h.latest.results.retry())
    expect(ids()).toHaveLength(60)
    expect(h.latest.results.error).toBeNull()
})
it('resets the loaded window for a new filter and ignores an old next page', async () => {
    await loadThree()
    const next = held<ReturnType<typeof page>>()
    boundary.read.mockReturnValueOnce(next.promise)
    let loading!: Promise<void>
    await act(async () => { loading = h.latest.results.loadMore() })
    await act(async () => h.latest.position.setValue('C'))
    await act(async () => { next.resolve(page(60)); await loading })
    expect(ids()).toHaveLength(20)
    expect(h.latest.position.value).toBe('C')
})

it.each([
    ['trade', 'trade_value_cache'], ['forecast', 'matchup_forecasts'],
    ['score', 'standings_current'], ['score', 'matchup_totals'],
])('skips a %s publication from %s without player changes', async (topic, table) => {
    await loadThree()
    const previous = ids()
    await act(async () => bumpView('league', topic, [table]))
    expect(boundary.read).toHaveBeenCalledTimes(3)
    expect(ids()).toEqual(previous)
})
it.each([
    ['score', undefined], ['score', []], ['score', ['unknown']],
    ['score', ['standings_current', 'player_game_stats']],
    ['resources', ['player_season_averages']], ['catchup', ['standings_current']],
    ['unknown', ['standings_current']],
])('refreshes conservatively for %s with sources %j', async (topic, tables) => {
    await loadThree()
    await act(async () => bumpView('league', topic, tables))
    expect(boundary.read).toHaveBeenCalledTimes(6)
    expect(ids()).toHaveLength(60)
})
it('applies live totals from later pages and replaces them on refresh', async () => {
    boundary.read.mockImplementation(async scope => ({ ...page(Number(scope.params.offset ?? 0)), visibleTotals: [{
        player_id: `player-${scope.params.offset ?? 0}`, totals: { points: revision * 10, points_count: 2, games_played: 2 },
        rounded_fantasy_average: null, game_status: 'Final', game_time: null, started_at: null,
    }] }))
    await loadThree()
    expect(h.latest.results.players[40].avg_fantasy_points).toBe(5)
    revision = 2
    await act(async () => bumpView('league', 'stat'))
    expect(h.latest.results.players[40].avg_fantasy_points).toBe(10)
})

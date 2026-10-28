import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { playerHarness, playerPayload } from '../helpers/player-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'
import { currentSeasonYear } from '@/lib/shared/season'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = playerHarness()
beforeEach(() => { boundary.read.mockImplementation(async scope => playerPayload(String(scope.params.playerId))) })
it.each(['hidden', 'offline', 'inactive'] as const)('defers %s cards and catches up only the current player', async mode => {
    boundary.hidden = mode === 'hidden'; boundary.online = mode !== 'offline'; boundary.focused = mode !== 'inactive'
    await h.render()
    expect(boundary.read).not.toHaveBeenCalled()
    boundary.hidden = false; boundary.online = true; boundary.focused = true
    await h.render({ player: 'new' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')) })
    await h.render({ player: 'new' })
    expect(h.latest.player?.id).toBe('new')
    expect(boundary.read.mock.calls.every(([scope]) => scope.params.playerId === 'new')).toBe(true)
})
it('fences late responses and never reloads an inactive route', async () => {
    const old = held<ReturnType<typeof playerPayload>>()
    boundary.read.mockReturnValueOnce(old.promise)
    await h.render(); boundary.focused = false; await h.render({ player: 'new' })
    await act(async () => old.resolve(playerPayload('old')))
    expect(h.latest.player).toBeNull()
    expect(boundary.read).toHaveBeenCalledOnce()
    boundary.focused = true; await h.render({ player: 'new' })
    expect(h.latest.player?.id).toBe('new')
})
it('pages the downloaded season locally and retains the season across suspension', async () => {
    const downloaded = playerPayload('player', 31)
    downloaded.lines.push(downloaded.lines[0])
    boundary.read.mockResolvedValue(downloaded)
    await h.render(); await act(async () => { h.latest.handleSeasonSelect(currentSeasonYear() - 1) })
    expect(h.latest.gameLog).toHaveLength(15)
    await act(async () => { await h.latest.loadMoreGames(); await h.latest.loadMoreGames(); await h.latest.loadMoreGames() })
    expect(h.latest.gameLog).toHaveLength(30)
    await act(async () => { await h.latest.loadMoreGames() })
    expect(h.latest.gameLog).toHaveLength(31)
    expect(h.latest.hasMoreGames).toBe(false)
    const reads = boundary.read.mock.calls.length
    boundary.focused = false; await h.render(); boundary.focused = true; await h.render()
    expect(h.latest.selectedSeason).toBe(currentSeasonYear() - 1)
    expect(boundary.read).toHaveBeenCalledTimes(reads)
})
it('waits for one complete view before settling all initial cards', async () => {
    const next = held<ReturnType<typeof playerPayload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    await h.render()
    expect(h.latest.initialSettled).toBe(false)
    expect(h.latest.projectionSettled).toBe(false)
    expect(h.latest.transactionsSettled).toBe(false)
    await act(async () => next.resolve(playerPayload()))
    expect(h.latest.initialSettled && h.latest.projectionSettled).toBe(true)
    expect(h.latest.transactionsSettled).toBe(false)
})
it('keeps the prior numbers through a pending version refresh', async () => {
    await h.render(); const next = held<ReturnType<typeof playerPayload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    await act(async () => bumpView('league', 'stat'))
    expect(h.latest.seasonAverages?.avgPoints).toBe(22)
    await act(async () => next.resolve(playerPayload('player', 1, 32)))
    expect(h.latest.seasonAverages?.avgPoints).toBe(32)
})
it.each(['roster', 'resources', 'stat', 'game', 'settings'])('refreshes cards on a %s version with the correct player scope', async topic => {
    await h.render(); boundary.read.mockResolvedValue(playerPayload('player', 1, 42))
    await act(async () => bumpView('league', topic))
    expect(h.latest.nextProjection?.projection_fantasy_points).toBe(42)
    expect(h.latest.seasonAverages?.avgPoints).toBe(42)
    expect(boundary.read.mock.calls.at(-1)?.[0].params.playerId).toBe('player')
})
it('does not request private data without authorized membership', async () => {
    await h.render({ authorized: false })
    expect(boundary.read).not.toHaveBeenCalled()
    expect(h.latest.transactions).toEqual([])
    await h.render()
    expect(h.latest.player?.id).toBe('player')
})
it('hides the prior season while a different season is pending and retries a failed view', async () => {
    await h.render(); boundary.read.mockRejectedValueOnce(new Error('season unavailable'))
    await act(async () => { h.latest.handleSeasonSelect(currentSeasonYear() - 1) })
    await h.render()
    expect(h.latest.gameLog).toEqual([])
    expect(h.latest.seasonError).toBe('season unavailable')
    await act(async () => { h.latest.retrySeason() })
    expect(h.latest.seasonError).toBeNull()
    expect(h.latest.gameLog).toHaveLength(1)
})
it('keeps the supplied scoring rules until a new view arrives', async () => {
    await h.render()
    expect(h.latest.avgFantasyPoints).toBe(22)
    const next = { ...playerPayload(), scoringSettings: { points: 2 } }
    boundary.read.mockResolvedValue(next)
    await act(async () => bumpView('league', 'settings'))
    expect(h.latest.avgFantasyPoints).toBe(44)
})
it('reuses unchanged cards on resume without a data read', async () => {
    await h.render(); const player = h.latest.player
    boundary.focused = false; await h.render(); boundary.focused = true; await h.render()
    expect(h.latest.player).toBe(player)
    expect(boundary.read).toHaveBeenCalledOnce()
})

import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'
import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { playerHarness, playerPayload } from '../helpers/player-view-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = playerHarness()
const rows = playerPayload('player', 45).lines
const cursor = (index: number) => ({ date: rows[index].game_date, id: rows[index].id })
const page = (offset: number, version = '1') => ({ context: { version }, lines: rows.slice(offset, offset + 15), hasMoreGames: offset < 30, nextGameCursor: offset < 30 ? cursor(offset + 14) : null })
beforeEach(() => { boundary.read.mockImplementation(async scope => scope.params.section === 'games'
    ? page(scope.params.gameAfter ? rows.findIndex(row => row.id === (scope.params.gameAfter as { id: string }).id) + 1 : 0)
    : { ...playerPayload(), lines: undefined }); })

it('loads fixed pages using the last visible row without downloading earlier pages', async () => {
    await h.render()
    await act(async () => h.latest.toggleSection('games'))
    expect(h.latest.gameLog).toHaveLength(15)
    await act(async () => h.latest.loadMoreGames())
    expect(h.latest.gameLog).toHaveLength(30)
    expect(boundary.read.mock.calls.at(-1)?.[0].params).toMatchObject({ gameLimit: 15, gameAfter: cursor(14) })
    await act(async () => h.latest.loadMoreGames())
    expect(h.latest.gameLog).toHaveLength(45)
    expect(h.latest.hasMoreGames).toBe(false)
    const count = boundary.read.mock.calls.length
    await act(async () => h.latest.loadMoreGames())
    expect(boundary.read).toHaveBeenCalledTimes(count)
})

it('keeps prior rows through a failed next page and retries the same cursor', async () => {
    await h.render()
    await act(async () => h.latest.toggleSection('games'))
    boundary.read.mockRejectedValueOnce(new Error('page unavailable'))
    await act(async () => h.latest.loadMoreGames())
    expect(h.latest.gameLog).toHaveLength(15)
    expect(h.latest.gameLogError).toBe('page unavailable')
    boundary.read.mockResolvedValueOnce(page(15))
    await act(async () => { await h.latest.retryGames() })
    expect(h.latest.gameLog).toHaveLength(30)
    expect(boundary.read.mock.calls.at(-1)?.[0].params.gameAfter).toEqual(cursor(14))
})

it('drops old pages when a revision changes and restarts from the current first page', async () => {
    await h.render()
    await act(async () => h.latest.toggleSection('games'))
    await act(async () => h.latest.loadMoreGames())
    boundary.read.mockImplementation(async scope => scope.params.section === 'games'
        ? page(scope.params.gameAfter ? 15 : 0, '2') : { ...playerPayload(), lines: undefined, context: { version: '2' } })
    await act(async () => bumpView('league', 'stat'))
    await h.render()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
    expect(h.latest.gameLog).toHaveLength(15)
    expect(boundary.read.mock.calls.at(-1)?.[0].params.gameAfter).toBeUndefined()
})

it('fences a late page when the selected player changes', async () => {
    await h.render()
    await act(async () => h.latest.toggleSection('games'))
    const pending = held<ReturnType<typeof page>>()
    boundary.read.mockReturnValueOnce(pending.promise)
    await act(async () => h.latest.loadMoreGames())
    await h.render({ player: 'second' })
    await act(async () => pending.resolve(page(15)))
    expect(h.latest.gameLog).toEqual([])
})

it('accepts a newer game page while the older overview remains in flight', async () => {
    await h.render()
    await act(async () => h.latest.toggleSection('games'))
    const pendingOverview = held<ReturnType<typeof playerPayload>>()
    boundary.read.mockImplementation(async scope => scope.params.section === 'overview'
        ? pendingOverview.promise : page(0, '2'))
    await act(async () => h.latest.retrySeason())
    await act(async () => { await h.latest.retryGames(true) })
    expect(h.latest.gameLog).toHaveLength(15)
    expect(h.latest.gameLogLoading).toBe(false)
    expect(h.latest.hasMoreGames).toBe(true)
})

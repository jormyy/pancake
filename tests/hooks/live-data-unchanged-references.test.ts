import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload, lineup } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = homeHarness()
beforeEach(() => { boundary.read.mockResolvedValue(homePayload()) })
it('reuses the same lineup reference while the server version stays unchanged', async () => {
    await h.render(); const previous = h.latest.myLineup
    for (let index = 0; index < 8; index += 1) await act(async () => { await h.latest.refreshSilently() })
    expect(h.latest.myLineup).toBe(previous)
    expect(boundary.read).toHaveBeenCalledOnce()
})
it.each(['Scheduled', 'InProgress', 'Final'])('applies the complete %s game snapshot', async status => {
    await h.render()
    const payload = { ...homePayload(), todaysGames: [{ id: 'game', status }], liveStats: { player: { points: 12 } } }
    boundary.read.mockResolvedValue(payload)
    await act(async () => { await bumpView('league', 'game') })
    expect(h.latest.liveSnapshot.todaysGames[0].status).toBe(status)
    expect(h.latest.liveSnapshot.liveStats.get('player')).toMatchObject({ points: 12 })
})
it.each(['DNP', 'correction', 'removal', 'metadata'])('applies a %s revision without keeping obsolete rows', async change => {
    await h.render()
    boundary.read.mockResolvedValue({ ...homePayload(undefined, 1), liveStats: change === 'removal' ? {} : { player: { points: 1, did_not_play: change === 'DNP' } }, todaysGames: [{ id: 'game', status: 'Final', home_team: 'BOS' }] })
    await act(async () => { await bumpView('league', 'stat') })
    expect(h.latest.matchup?.myPoints).toBe(1)
    expect(h.latest.liveSnapshot.liveStats.has('player')).toBe(change !== 'removal')
    expect(h.latest.liveSnapshot.todaysGames[0]).toMatchObject({ status: 'Final', home_team: 'BOS' })
})
it('applies roster assignment, full names, slot order and confirmed empty reserves', async () => {
    await h.render()
    const next = homePayload(); next.myLineup = { ...lineup('', 0), starters: [{ slotType: 'C', player: null }, { slotType: 'PG', player: { ...lineup('new-player').bench[0], rosterPlayerId: 'new-assignment', displayName: 'Full Player Name' } }] }
    boundary.read.mockResolvedValue(next)
    await act(async () => { await bumpView('league', 'lineup') })
    expect(h.latest.myLineup).toEqual(next.myLineup)
    expect(h.latest.myLineup?.starters.map(slot => slot.slotType)).toEqual(['C', 'PG'])
    expect(h.latest.myLineup?.benchSlots).toBe(0)
    expect(h.latest.myLineup?.bench).toEqual([])
})
it('keeps all empty places after a missed lineup change and a catchup version', async () => {
    await h.render()
    const next = homePayload(); next.myLineup = { ...lineup('', 5), starters: Array.from({ length: 10 }, () => ({ slotType: 'UTIL', player: null })) }
    boundary.read.mockResolvedValue(next)
    await act(async () => { await bumpView() })
    expect(h.latest.myLineup?.starters).toHaveLength(10)
    expect(h.latest.myLineup?.starters.every(slot => slot.player === null)).toBe(true)
    expect(h.latest.myLineup?.benchSlots).toBe(5)
})
it('rejects a pending equal lineup from the previous owner', async () => {
    const old = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(old.promise)
    await h.render(); await h.render({ member: 'other' }); const previous = h.latest.myLineup
    await act(async () => { await old.resolve(homePayload()) })
    expect(h.latest.myLineup).toBe(previous)
})

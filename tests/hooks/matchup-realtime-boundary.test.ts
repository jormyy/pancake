import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = homeHarness()
beforeEach(() => { boundary.read.mockResolvedValue(homePayload(undefined, 200)) })
it('rejects a former owner and league callback so 200 cannot become 12', async () => {
    const old = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(old.promise)
    await h.render()
    const former = [...boundary.listeners.get('league')!]
    await h.render({ league: 'other', member: 'other' })
    await act(async () => { for (const listener of former) listener({ version: '2', changes: [] }); old.resolve(homePayload(undefined, 12)) })
    expect(h.latest.matchup?.myPoints).toBe(200)
})
it('ignores duplicate and reversed versions while accepting downward score corrections', async () => {
    await h.render()
    boundary.read.mockResolvedValue(homePayload(undefined, 12))
    await act(async () => { await bumpView('league', 'score') })
    expect(h.latest.matchup?.myPoints).toBe(12)
    const calls = boundary.read.mock.calls.length
    await act(async () => { for (const listener of boundary.listeners.get('league')!) { listener({ version: '2', changes: [] }); listener({ version: '1', changes: [] }) } })
    expect(boundary.read).toHaveBeenCalledTimes(calls)
    expect(h.latest.matchup?.myPoints).toBe(12)
})
it.each(['score', 'lineup', 'roster', 'settings', 'season', 'catchup'])('reconciles %s versions from one complete view', async topic => {
    await h.render()
    const next = homePayload(undefined, 12); next.myLineup!.bench = []; next.oppLineup!.bench = []
    boundary.read.mockResolvedValue(next)
    await act(async () => { await bumpView('league', topic) })
    expect(h.latest.matchup?.myPoints).toBe(12)
    expect(h.latest.myLineup?.bench).toEqual([])
    expect(h.latest.oppLineup?.bench).toEqual([])
})
it('reuses the initial version and reads once after a later catchup', async () => {
    await h.render(); await h.unmount(); await h.render()
    expect(boundary.read).toHaveBeenCalledOnce()
    await act(async () => { await bumpView() })
    expect(boundary.read).toHaveBeenCalledTimes(2)
})

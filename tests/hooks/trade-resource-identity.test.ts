import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { tradeHarness, tradePayload, blockPayload } from '../helpers/trade-view-fixture'
import { trade } from '../helpers/fixtures'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'

const mutations = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/trades', async original => ({ ...await original<typeof import('@/lib/trades')>(), addTradeBlockItem: mutations.add, removeTradeBlockItem: mutations.remove }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = tradeHarness()
beforeEach(() => { mutations.add.mockReset().mockResolvedValue(undefined); mutations.remove.mockReset().mockResolvedValue(undefined); boundary.read.mockImplementation(async scope => scope.screen === 'trade-block' ? blockPayload() : tradePayload()) })
it('does not expose readiness from the previous member error', async () => {
    boundary.read.mockRejectedValueOnce(new Error('former member error'))
    await h.render({ tab: 'block' })
    expect(h.block.displayReady).toBe(true)
    boundary.read.mockReturnValueOnce(new Promise(() => {})); h.frames.length = 0
    await h.render({ tab: 'block', member: 'next' })
    expect(h.frames[0].block.displayReady).toBe(false)
    expect(h.block.error).toBeNull()
})
it('paginates history through its server view and opaque cursor', async () => {
    boundary.read.mockResolvedValueOnce(tradePayload(['first'], 'one')).mockResolvedValueOnce(tradePayload(['last']))
    await h.render({ tab: 'history' }); await act(async () => { await h.history.loadMore() })
    expect(h.history.trades.map(trade => trade.id)).toEqual(['first', 'last'])
    expect(boundary.read.mock.calls.map(([scope]) => [scope.params.tab, scope.params.cursor ?? null])).toEqual([['history', null], ['history', 'one']])
})
it.each(['offers', 'history', 'block'])('clears private %s data and rejects stale completion on member change', async tab => {
    const old = held<unknown>()
    boundary.read.mockReturnValueOnce(old.promise)
    await h.render({ tab }); boundary.read.mockReturnValueOnce(new Promise(() => {})); h.frames.length = 0
    await h.render({ tab, member: 'next' })
    expect(h.frames[0].offers.trades).toEqual([])
    expect(h.frames[0].history.trades).toEqual([])
    expect(h.frames[0].block.items).toEqual([])
    await act(async () => old.resolve(tab === 'block' ? blockPayload() : tradePayload(['old'])))
    expect(h.offers.trades).toEqual([])
    expect(h.history.trades).toEqual([])
})
it('rejects duplicate pages and cancels old pagination on refresh', async () => {
    boundary.read.mockResolvedValueOnce(tradePayload(['first'], 'one'))
    await h.render(); const old = held<ReturnType<typeof tradePayload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(tradePayload(['fresh']))
    let request!: Promise<void>
    await act(async () => { request = h.offers.loadMore(); void h.offers.loadMore() })
    expect(boundary.read).toHaveBeenCalledTimes(2)
    await act(async () => { await h.offers.refresh() })
    await act(async () => { old.resolve(tradePayload(['old'])); await request })
    expect(h.offers.trades.map(trade => trade.id)).toEqual(['fresh'])
})
it('continues from server cursors when a page contains only duplicates', async () => {
    boundary.read.mockResolvedValueOnce(tradePayload(['first'], 'one')).mockResolvedValueOnce(tradePayload(['first'], 'two')).mockResolvedValueOnce(tradePayload(['last']))
    await h.render(); await act(async () => { await h.offers.loadMore() }); expect(h.offers.hasMore).toBe(true)
    await act(async () => { await h.offers.loadMore() })
    expect(h.offers.trades.map(trade => trade.id)).toEqual(['first', 'last'])
    expect(h.offers.hasMore).toBe(false)
    expect(boundary.read.mock.calls.map(([scope]) => scope.params.cursor ?? null)).toEqual([null, 'one', 'two'])
})
it('keeps a settled empty block available during refresh', async () => {
    await h.render({ tab: 'block' }); const next = held<ReturnType<typeof blockPayload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    let request!: Promise<boolean>
    await act(async () => { request = h.block.refresh() })
    expect(h.block.hasData).toBe(true)
    expect(h.block.loading).toBe(false)
    expect(h.block.refreshing).toBe(true)
    expect(h.block.items).toEqual([])
    await act(async () => { next.resolve(blockPayload()); await request })
})
it('keeps block listings, roster and averages when the complete view refresh fails', async () => {
    const payload = { ...blockPayload(), avgMap: { 'player-1': 14 } }
    boundary.read.mockResolvedValue(payload); await h.render({ tab: 'block' })
    boundary.read.mockRejectedValueOnce(new Error('view unavailable'))
    await act(async () => { await h.block.refresh() })
    expect(h.block.roster).toEqual(payload.roster)
    expect(h.block.avgMap.get('player-1')).toBe(14)
    expect(h.block.error).toBe('view unavailable')
})
it('retains a saved mutation when its following view refresh fails', async () => {
    await h.render({ tab: 'block' }); boundary.read.mockRejectedValueOnce(new Error('refresh unavailable'))
    await act(async () => { await h.block.addPick({ kind: 'pick', pickId: 'pick', seasonYear: 2027, round: 1, originalTeamName: 'Own' }) })
    expect(mutations.add).toHaveBeenCalledOnce()
    expect(h.block.actionError).toBeNull()
    expect(h.block.error).toBe('refresh unavailable')
})
it('serializes block mutations and refreshes both successful writes', async () => {
    await h.render({ tab: 'block' }); const first = held<void>()
    mutations.add.mockReturnValueOnce(first.promise)
    let one!: Promise<void>, two!: Promise<void>
    const pick = { kind: 'pick' as const, pickId: 'pick', seasonYear: 2027, round: 1, originalTeamName: 'Own' }
    await act(async () => { one = h.block.addPick(pick); two = h.block.addPick({ ...pick, pickId: 'next' }) })
    expect(mutations.add).toHaveBeenCalledOnce()
    await act(async () => { first.resolve(); await one; await two })
    expect(mutations.add).toHaveBeenCalledTimes(2)
    expect(boundary.read).toHaveBeenCalledTimes(3)
})
it('does not refresh after a mutation outlives its owner', async () => {
    await h.render({ tab: 'block' }); const first = held<void>(); mutations.add.mockReturnValueOnce(first.promise)
    let request!: Promise<void>
    await act(async () => { request = h.block.addPick({ kind: 'pick', pickId: 'pick', seasonYear: 2027, round: 1, originalTeamName: 'Own' }) })
    await h.render({ tab: 'block', member: 'next' }); const reads = boundary.read.mock.calls.length
    await act(async () => { first.resolve(); await request })
    expect(boundary.read).toHaveBeenCalledTimes(reads)
})
it('retains offers but blocks decisions until reconnect validation settles', async () => {
    await h.render(); boundary.online = false; await h.render({ online: false })
    expect(h.offers.trades.map(trade => trade.id)).toEqual(['first'])
    expect(h.offers.isSnapshot).toBe(true)
    const next = held<ReturnType<typeof tradePayload>>()
    boundary.read.mockReturnValueOnce(next.promise); bumpView(); boundary.online = true
    await h.render(); await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(h.offers.trades.map(trade => trade.id)).toEqual(['first'])
    expect(h.offers.isSnapshot).toBe(true)
    await act(async () => next.resolve(tradePayload(['fresh'])))
    expect(h.offers.isSnapshot).toBe(false)
})
it('marks the first history render pending', async () => {
    boundary.read.mockReturnValueOnce(new Promise(() => {})); await h.render({ tab: 'history' })
    expect(h.frames[0].history.hasData).toBe(false)
    expect(h.frames[0].history.loading).toBe(true)
})
it.each([false, true])('applies the saved plan and preserves inherited taxi placement %s', async inherited => {
    const incoming = { kind: 'player' as const, playerId: 'incoming', playerName: 'Incoming', position: 'PG', nbaTeam: 'LAL', fromMemberId: 'other', toMemberId: 'member', fromTaxi: inherited, toTaxi: true }
    boundary.read.mockResolvedValue({ ...tradePayload(), trades: [trade({ id: 'first', routedItems: [incoming], participants: [{ memberId: 'member', teamName: 'A', sortOrder: 0, isInitiator: true, acceptedAt: '2026-01-01', dropPlayerIds: [] }] }), trade({ id: 'other' })] })
    await h.render(); const reads = boundary.read.mock.calls.length, other = h.offers.trades[1]
    await act(async () => { h.offers.updateRosterPlan('first', { taxiPlayerIds: [], irPlayerIds: ['incoming'], dropPlayerIds: ['drop'] }) })
    expect(h.offers.trades[0].routedItems[0]).toMatchObject({ toTaxi: inherited, toIR: true })
    expect(h.offers.trades[0].participants[0].dropPlayerIds).toEqual(['drop'])
    expect(h.offers.trades[1]).toBe(other)
    expect(boundary.read).toHaveBeenCalledTimes(reads)
})
it.each(['empty', 'history'])('does not auto-page a complete %s first page', async kind => {
    boundary.read.mockResolvedValue(tradePayload(kind === 'empty' ? [] : ['completed']))
    await h.render(); await act(async () => { await h.offers.loadMore() })
    expect(h.offers.hasMore).toBe(false)
    expect(boundary.read).toHaveBeenCalledOnce()
})

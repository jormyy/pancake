import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useLeagueTabResources } from '@/hooks/use-league-tab-resources'
import type { LeagueTab } from '@/lib/league/tabs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined, latest: ReturnType<typeof useLeagueTabResources>
const frames: string[][] = []
const Probe = ({ member = 'member', tab = 'history', authorized = true }: { member?: string; tab?: LeagueTab; authorized?: boolean }) => { latest = useLeagueTabResources('league', member || undefined, tab, authorized); frames.push(latest.transactions.map(row => row.id)); return null }
const render = async (props = {}) => { await act(async () => { if (screen) screen.update(React.createElement(Probe, props)); else screen = create(React.createElement(Probe, props)) }); await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
const page = (offset = 0, count = 50) => Array.from({ length: count }, (_, index) => ({ id: `row-${offset + index}`, occurredAt: new Date(Date.UTC(2026, 9, 27, 12, -offset - index)).toISOString() }))
let total = 200
beforeEach(() => { frames.length = 0; total = 200; boundary.read.mockImplementation(async scope => { const offset = Number(scope.params.offset ?? 0), limit = Number(scope.params.limit ?? 50), rows = page().concat(page(50), page(100), page(150)).slice(offset, Math.min(total, offset + limit)); return { rows, offset: offset + rows.length, hasMore: rows.length === limit } }) })
afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined })
it('rejects mock rooms loaded for the previous member', async () => {
    const old = held<unknown>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue({ rooms: [{ id: 'new' }] })
    await render({ tab: 'mockRooms' }); await render({ tab: 'mockRooms', member: 'new' })
    await act(async () => old.resolve({ rooms: [{ id: 'old' }] }))
    expect(latest.mockRooms.map(room => room.id)).toEqual(['new'])
})
it('keeps operations stable and preserves loaded history pages on refresh', async () => {
    await render(); const invalidate = latest.invalidateTab
    await act(async () => { await latest.loadMoreActivity() })
    await act(async () => { await latest.refreshTab('history') })
    expect(latest.transactions).toHaveLength(100)
    expect(latest.invalidateTab).toBe(invalidate)
    await act(async () => { await latest.loadMoreActivity() })
    expect(boundary.read.mock.calls.at(-1)?.[0].params.offset).toBe(100)
})
it('fences an older pagination reply when refresh starts', async () => {
    await render(); const old = held<unknown>()
    boundary.read.mockReturnValueOnce(old.promise)
    let request!: Promise<void>
    await act(async () => { request = latest.loadMoreActivity() })
    await act(async () => { await latest.refreshTab('history') })
    await act(async () => { old.resolve({ rows: [{ id: 'obsolete' }], offset: 100, hasMore: true }); await request })
    expect(latest.transactions.map(row => row.id)).not.toContain('obsolete')
})
it('stops at an empty final page', async () => {
    total = 50; await render(); await act(async () => { await latest.loadMoreActivity() })
    expect(latest.activityHasMore).toBe(false)
    expect(latest.transactions).toHaveLength(50)
})
it('keeps a failed offset across suspension and fences a removed member', async () => {
    await render(); boundary.read.mockRejectedValueOnce(new Error('page unavailable'))
    await act(async () => { await latest.loadMoreActivity() })
    expect(latest.activityLoadMoreError).toBe('page unavailable')
    boundary.hidden = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await latest.loadMoreActivity() })
    expect(boundary.read).toHaveBeenCalledTimes(2)
    boundary.hidden = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await latest.loadMoreActivity() })
    expect(boundary.read.mock.calls.at(-1)?.[0].params.offset).toBe(50)
    await render({ member: '', authorized: false })
    const reads = boundary.read.mock.calls.length
    await act(async () => { await latest.refreshTab('history'); await latest.loadMoreActivity() })
    expect(boundary.read).toHaveBeenCalledTimes(reads)
    expect(latest.transactions).toEqual([])
})
it('deduplicates shifted pages and uses the server offset', async () => {
    await render(); boundary.read.mockResolvedValueOnce({ rows: page(49), offset: 100, hasMore: true })
    await act(async () => { await latest.loadMoreActivity() })
    expect(latest.transactions).toHaveLength(99)
    await act(async () => { await latest.loadMoreActivity() })
    expect(boundary.read.mock.calls.at(-1)?.[0].params.offset).toBe(100)
})
it.each(['roster', 'inventory', 'resources', 'announcement'])('refreshes visible history after a %s version', async topic => {
    await render(); boundary.read.mockResolvedValue({ rows: [{ id: 'fresh' }], offset: 1, hasMore: false })
    await act(async () => bumpView('league', topic))
    expect(latest.transactions.map(row => row.id)).toEqual(['fresh'])
})
it('defers another tab until selection and ignores former league versions', async () => {
    await render(); await render({ tab: 'results' }); const reads = boundary.read.mock.calls.length
    await act(async () => bumpView('other', 'inventory'))
    expect(boundary.read).toHaveBeenCalledTimes(reads)
    await act(async () => bumpView('league', 'inventory'))
    expect(boundary.read.mock.calls.at(-1)?.[0].params.tab).toBe('results')
    await render()
    expect(boundary.read.mock.calls.at(-1)?.[0].params.tab).toBe('history')
})
it('restores the same owner cache after a generation change', async () => {
    await render(); await act(async () => screen?.unmount()); screen = undefined; boundary.generation += 1; frames.length = 0
    await render()
    expect(frames[0]).toHaveLength(50)
    expect(boundary.read).toHaveBeenCalledOnce()
})
it.each([125, 200])('caps a refresh and keeps history pageable with %s rows', async remaining => {
    await render(); await act(async () => { await latest.loadMoreActivity() }); await act(async () => { await latest.loadMoreActivity() })
    total = remaining
    await act(async () => { await latest.refreshTab('history') })
    expect(latest.transactions).toHaveLength(100)
    expect(latest.activityHasMore).toBe(true)
    await act(async () => { await latest.loadMoreActivity() })
    expect(latest.transactions).toHaveLength(Math.min(remaining, 150))
    expect(boundary.read.mock.calls.every(([scope]) => Number(scope.params.limit) <= 100)).toBe(true)
})
it.each([51, 75, 99])('keeps complete %s-row history complete after refresh', async count => {
    total = count; await render(); await act(async () => { await latest.loadMoreActivity() }); await act(async () => { await latest.refreshTab('history') })
    expect(latest.transactions).toHaveLength(count)
    expect(latest.activityHasMore).toBe(false)
})
it('merges commissioner announcements by publish time', async () => {
    boundary.read.mockResolvedValue({ rows: [{ id: 'transaction', occurredAt: '2026-10-27T12:00:00Z' }], announcements: [{ id: 'new', body: 'Draft tonight.', published_at: '2026-10-27T15:00:00Z' }, { id: 'old', body: 'Welcome.', published_at: '2026-10-26T15:00:00Z' }], offset: 1, hasMore: false })
    await render()
    expect(latest.transactions.map(row => row.id)).toEqual(['announcement:new', 'transaction', 'announcement:old'])
    expect(latest.transactions[0]).toMatchObject({ title: 'Commissioner', body: 'Draft tonight.' })
})
it('waits for older pages before merging their announcements', async () => {
    boundary.read.mockImplementation(async scope => { const offset = Number(scope.params.offset ?? 0); return { rows: page(offset), offset: offset + 50, hasMore: offset === 0, announcements: [{ id: 'recent', published_at: page()[0].occurredAt }, { id: 'oldest', published_at: '2026-09-01T00:00:00Z' }] } })
    await render()
    expect(latest.transactions.filter(row => row.transactionType === 'commissioner_announcement').map(row => row.id)).toEqual(['announcement:recent'])
    await act(async () => { await latest.loadMoreActivity() })
    expect(latest.transactions.filter(row => row.transactionType === 'commissioner_announcement').map(row => row.id)).toEqual(['announcement:recent', 'announcement:oldest'])
})

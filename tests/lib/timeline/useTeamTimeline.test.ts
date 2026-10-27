import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTeamTimeline } from '@/lib/timeline/useTeamTimeline'
import type { TimelineEvent, TimelinePage } from '@/lib/timeline'

const mocks = vi.hoisted(() => ({ read: vi.fn(), generation: 0 }))
vi.mock('@/lib/timeline', () => ({ getTeamTimeline: mocks.read }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => mocks.generation }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const event = (id: string): TimelineEvent => ({ id, createdAt: '2026-10-27T10:00:00Z', kind: 'claim.failed',
    summary: 'Waiver claim failed', reason: 'Another team bid more.', memberId: 'a', entityId: id, detail: { bid_amount: 12 } })
const page = (ids: string[], more = false): TimelinePage => ({ events: ids.map(event), hasMore: more,
    nextCursor: more ? { createdAt: '2026-10-27T10:00:00Z', id: ids.at(-1)! } : null })
function deferred() {
    let resolve!: (value: TimelinePage) => void
    const promise = new Promise<TimelinePage>(done => { resolve = done })
    return { promise, resolve }
}
let latest!: ReturnType<typeof useTeamTimeline>
function Probe({ memberId = 'a', enabled = true }: { memberId?: string; enabled?: boolean }) {
    latest = useTeamTimeline({ leagueId: 'league', memberId, enabled })
    return null
}
beforeEach(() => { mocks.read.mockReset(); mocks.generation = 0 })

describe('team timeline requests', () => {
    it('loads exact reasons and bids without rewriting them', async () => {
        mocks.read.mockResolvedValue(page(['3']))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.events[0].reason).toBe('Another team bid more.')
        expect(latest.events[0].detail.bid_amount).toBe(12)
        expect(mocks.read).toHaveBeenCalledWith('league', 'a')
        await act(async () => { renderer.unmount() })
    })
    it('keeps cursor order and removes duplicate entries when paging', async () => {
        mocks.read.mockResolvedValueOnce(page(['3', '2'], true)).mockResolvedValueOnce(page(['2', '1']))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.loadMore() })
        expect(mocks.read).toHaveBeenLastCalledWith('league', 'a', { createdAt: '2026-10-27T10:00:00Z', id: '2' })
        expect(latest.events.map(item => item.id)).toEqual(['3', '2', '1'])
        expect(latest.hasMore).toBe(false)
        await act(async () => { renderer.unmount() })
    })
    it('drops an old team response after the team changes', async () => {
        const old = deferred()
        mocks.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(['new']))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { renderer.update(React.createElement(Probe, { memberId: 'b' })) })
        await act(async () => { old.resolve(page(['private-old'])) })
        expect(latest.events.map(item => item.id)).toEqual(['new'])
        await act(async () => { renderer.unmount() })
    })
    it('drops replies from the previous signed-in session', async () => {
        const old = deferred()
        mocks.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(['new-user']))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        mocks.generation += 1
        await act(async () => { renderer.update(React.createElement(Probe)) })
        await act(async () => { old.resolve(page(['private-old'])) })
        expect(latest.events.map(item => item.id)).toEqual(['new-user'])
        await act(async () => { renderer.unmount() })
    })
    it('makes one paging request and preserves the cursor for retry', async () => {
        const next = deferred()
        mocks.read.mockResolvedValueOnce(page(['3'], true)).mockReturnValueOnce(next.promise).mockResolvedValueOnce(page(['2']))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let loading!: Promise<void>
        await act(async () => { loading = latest.loadMore(); await latest.loadMore() })
        expect(mocks.read).toHaveBeenCalledTimes(2)
        await act(async () => { next.resolve(page(['2'])); await loading })
        expect(latest.events.map(item => item.id)).toEqual(['3', '2'])
        await act(async () => { renderer.unmount() })
    })
    it('shows a page error and retries without losing loaded entries', async () => {
        mocks.read.mockResolvedValueOnce(page(['3'], true)).mockRejectedValueOnce({ message: 'Connection lost' }).mockResolvedValueOnce(page(['2']))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.loadMore() })
        expect(latest.error).toBe('Connection lost')
        expect(latest.events.map(item => item.id)).toEqual(['3'])
        await act(async () => { await latest.retry() })
        expect(latest.error).toBeNull()
        expect(latest.events.map(item => item.id)).toEqual(['3', '2'])
        await act(async () => { renderer.unmount() })
    })
    it('prevents a pending page from replacing a refreshed page', async () => {
        const old = deferred()
        mocks.read.mockResolvedValueOnce(page(['3'], true)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(['5']))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let loading!: Promise<void>
        await act(async () => { loading = latest.loadMore() })
        await act(async () => { await latest.refresh() })
        await act(async () => { old.resolve(page(['2'])); await loading })
        expect(latest.events.map(item => item.id)).toEqual(['5'])
        await act(async () => { renderer.unmount() })
    })
    it('retries a failed refresh even when older pages remain', async () => {
        mocks.read.mockResolvedValueOnce(page(['3'], true)).mockRejectedValueOnce({ message: 'Refresh failed' }).mockResolvedValueOnce(page(['4'], true))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.refresh() })
        expect(latest.error).toBe('Refresh failed')
        await act(async () => { await latest.retry() })
        expect(mocks.read).toHaveBeenLastCalledWith('league', 'a')
        expect(latest.events.map(item => item.id)).toEqual(['4'])
        await act(async () => { renderer.unmount() })
    })
    it('clears private rows when disabled and does not request data', async () => {
        mocks.read.mockResolvedValue(page(['3']))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { renderer.update(React.createElement(Probe, { enabled: false })) })
        expect(latest.events).toEqual([])
        expect(mocks.read).toHaveBeenCalledTimes(1)
        await act(async () => { renderer.unmount() })
    })
})

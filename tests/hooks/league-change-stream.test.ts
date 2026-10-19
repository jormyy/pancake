import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TableChangeWatch } from '@/lib/realtime-config'

const boundary = vi.hoisted(() => ({ subscriptions: [] as { watches: TableChangeWatch[]; onStatus: (status: string) => void }[], remove: vi.fn(), baseline: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ eq: boundary.baseline }) }) } }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: (_name: string, subscription: typeof boundary.subscriptions[number]) => { boundary.subscriptions.push(subscription); return subscription },
    unsubscribeFromTableChanges: boundary.remove, reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let useLeagueChangeStream: typeof import('@/hooks/use-league-change-stream').useLeagueChangeStream
let state: typeof import('@/lib/league-changes')
let sessions: typeof import('@/lib/session-cache-registry')
let renderer: ReactTestRenderer | null
const Probe = ({ league = 'one', user = 'user', validated = true }) => { useLeagueChangeStream(league, user, validated); return null }
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); boundary.subscriptions.length = 0
    boundary.baseline.mockResolvedValue({ data: [], error: null })
    renderer = null
    ;({ useLeagueChangeStream } = await import('@/hooks/use-league-change-stream'))
    state = await import('@/lib/league-changes')
    sessions = await import('@/lib/session-cache-registry')
})
afterEach(() => { act(() => renderer?.unmount()) })

it('uses one league stream, catches up after each real subscription, and fences a former account', async () => {
    sessions.setSessionOwner('user')
    const listen = vi.fn()
    const stop = state.listenForLeagueChanges('one', listen)
    await act(async () => { renderer = create(React.createElement(Probe, {})) })
    expect(boundary.subscriptions).toHaveLength(1)
    const first = boundary.subscriptions[0]
    await act(async () => { first.onStatus('SUBSCRIBED'); await new Promise(resolve => setTimeout(resolve, 10)) })
    first.onStatus('CHANNEL_ERROR')
    expect(state.leagueChangesConnected('one')).toBe(false)
    await act(async () => { first.onStatus('SUBSCRIBED'); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(listen).toHaveBeenCalledTimes(2)
    expect(state.leagueChangesConnected('one')).toBe(true)
    await act(async () => { sessions.setSessionOwner('other'); renderer!.update(React.createElement(Probe, { user: 'other', league: 'two' })) })
    first.onStatus('SUBSCRIBED')
    expect(listen).toHaveBeenCalledTimes(2)
    expect(state.leagueChangesConnected('one')).toBe(false)
    expect(boundary.remove).toHaveBeenCalledOnce()
    stop()
})

it('does not subscribe for unvalidated membership and drops retained row callbacks after cleanup', async () => {
    const receive = vi.fn()
    const stop = state.listenForLeagueChanges('one', receive)
    await act(async () => { renderer = create(React.createElement(Probe, { validated: false })) })
    expect(boundary.subscriptions).toHaveLength(0)
    await act(async () => { renderer!.update(React.createElement(Probe, { validated: true })) })
    const subscription = boundary.subscriptions[0]
    const payload = { eventType: 'UPDATE' as const, schema: 'public', table: 'league_change_hints', commit_timestamp: '2026-10-18T12:00:00Z', errors: [], old: {}, new: { league_id: 'one', topic: 'stat', scopes: null, revision: 1 } }
    subscription.watches[0].onChange(payload)
    expect(receive).toHaveBeenCalledOnce()
    await act(async () => { renderer?.unmount() }); renderer = null
    subscription.watches[0].onChange({ ...payload, new: { ...payload.new, revision: 2 } })
    expect(receive).toHaveBeenCalledOnce()
    stop()
})

it('reads a fresh baseline on reconnect while an older baseline is held and rejects its late reply', async () => {
    let release!: (value: { data: Record<string, unknown>[]; error: null }) => void
    boundary.baseline.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
        .mockResolvedValue({ data: [{ league_id: 'one', topic: 'inventory', revision: 8, scopes: null, details: null }], error: null })
    const listen = vi.fn()
    const stop = state.listenForLeagueChanges('one', listen)
    await act(async () => { renderer = create(React.createElement(Probe)) })
    const subscription = boundary.subscriptions[0]
    await act(async () => { subscription.onStatus('SUBSCRIBED'); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(state.leagueChangesConnected('one')).toBe(false)
    await act(async () => { subscription.onStatus('CHANNEL_ERROR'); subscription.onStatus('SUBSCRIBED'); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(state.leagueChangesConnected('one')).toBe(true)
    expect(boundary.baseline).toHaveBeenCalledTimes(2)
    const count = listen.mock.calls.length
    await act(async () => { release({ data: [{ league_id: 'one', topic: 'inventory', revision: 99, scopes: null }], error: null }) })
    expect(listen).toHaveBeenCalledTimes(count)
    stop()
})

it('keeps a failed baseline untrusted and retries it before marking the stream fresh', async () => {
    boundary.baseline.mockResolvedValueOnce({ data: null, error: new Error('unavailable') })
        .mockResolvedValue({ data: [], error: null })
    await act(async () => { renderer = create(React.createElement(Probe)) })
    const subscription = boundary.subscriptions[0]
    await act(async () => { subscription.onStatus('SUBSCRIBED'); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(state.leagueChangesConnected('one')).toBe(false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)) })
    expect(state.leagueChangesConnected('one')).toBe(true)
    expect(boundary.baseline).toHaveBeenCalledTimes(2)
})

it('never certifies a baseline with an unsafe counter', async () => {
    boundary.baseline.mockResolvedValue({ data: [{ league_id: 'one', topic: 'inventory', revision: Number.MAX_SAFE_INTEGER + 1, scopes: null, details: null }], error: null })
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { boundary.subscriptions[0].onStatus('SUBSCRIBED'); await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(state.leagueChangesConnected('one')).toBe(false)
})

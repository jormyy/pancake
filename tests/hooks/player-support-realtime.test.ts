import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { notifyLeagueChange } from '@/lib/league-changes'
import { PanelActivityContext } from '@/contexts/panel-activity'
import { usePlayerSupportRealtime } from '@/hooks/use-player-support-realtime'

const boundary = vi.hoisted(() => ({
    subscription: null as null | { watches: { table: string; onChange: () => void }[]; onReconnect: () => unknown },
    support: vi.fn(), recover: vi.fn(), stop: vi.fn(), invalidateSeason: vi.fn(),
}))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: (_name: string, options: NonNullable<typeof boundary.subscription>) => { boundary.subscription = options; return {} },
    unsubscribeFromTableChanges: boundary.stop, reportRealtimeCleanup: vi.fn(),
}))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: boundary.invalidateSeason }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer
const Probe = () => { usePlayerSupportRealtime('member', 'league', boundary.support, boundary.recover); return null }
beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    boundary.subscription = null
    boundary.support.mockResolvedValue(true)
    boundary.recover.mockResolvedValue(true)
})
afterEach(async () => { await act(async () => { renderer.unmount() }); vi.useRealTimers() })

it('coalesces live availability changes without forcing search and keeps full reconnect recovery', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { boundary.subscription!.watches[0].onChange(); boundary.subscription!.watches[0].onChange(); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.support).toHaveBeenCalledTimes(1)
    expect(boundary.recover).not.toHaveBeenCalled()
    await act(async () => { await boundary.subscription!.onReconnect(); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.recover).toHaveBeenCalledTimes(1)
    expect(boundary.invalidateSeason).toHaveBeenCalledExactlyOnceWith('league')
})

it('retries failed availability reads and stops pending work when the screen leaves', async () => {
    boundary.support.mockResolvedValueOnce(false)
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { boundary.subscription!.watches[0].onChange(); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.support).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(boundary.support).toHaveBeenCalledTimes(2)
    await act(async () => { boundary.subscription!.watches[0].onChange(); renderer.update(React.createElement(React.Fragment)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.support).toHaveBeenCalledTimes(2)
    expect(boundary.recover).not.toHaveBeenCalled()
    expect(boundary.stop).toHaveBeenCalledTimes(1)
})


it('unsubscribes while its retained panel is hidden and resumes only its own visible channel', async () => {
    const panel = (active: boolean) => React.createElement(PanelActivityContext.Provider, { value: active }, React.createElement(Probe))
    await act(async () => { renderer = create(panel(false)) })
    expect(boundary.subscription).toBeNull()
    await act(async () => renderer.update(panel(true)))
    expect(boundary.subscription).not.toBeNull()
    await act(async () => { boundary.subscription!.watches[0].onChange(); renderer.update(panel(false)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(boundary.support).not.toHaveBeenCalled()
    expect(boundary.stop).toHaveBeenCalledOnce()
    await act(async () => renderer.update(panel(true)))
    await act(async () => { boundary.subscription!.watches[0].onChange(); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.support).toHaveBeenCalledOnce()
})

const seasonId = '10000000-0000-4000-8000-000000000001'
it('reads own claims without inferring the actor and ignores unrelated priority or future claims', async () => {
    const Scoped = () => { usePlayerSupportRealtime('member', 'league', boundary.support, boundary.recover, true, seasonId); return null }
    await act(async () => { renderer = create(React.createElement(Scoped)) })
    const emit = (resource: 'claims' | 'priority' | 'faab', season = seasonId, member_id?: string) => notifyLeagueChange('league', { topic: 'inventory', scopes: null, details: [{ resource, season_id: season, ...(member_id ? { member_id } : {}) }] })
    await act(async () => { emit('priority', seasonId, 'other'); emit('faab', seasonId, 'other'); emit('claims', 'future'); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.support).not.toHaveBeenCalled()
    expect(boundary.recover).not.toHaveBeenCalled()
    await act(async () => { emit('claims'); emit('faab', seasonId, 'member'); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.support).toHaveBeenCalledExactlyOnceWith(['claims', 'transactions'])
    expect(boundary.recover).not.toHaveBeenCalled()
})

it('broadens unknown inventory, preserves failed work, and rejoins a change during a held read', async () => {
    let release!: (result: boolean) => void
    boundary.support.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve }))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { boundary.subscription!.watches[0].onChange(); await vi.advanceTimersByTimeAsync(200) })
    await act(async () => { notifyLeagueChange('league', { topic: 'inventory', scopes: null, details: null }); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.recover).not.toHaveBeenCalled()
    await act(async () => { release(false); await vi.advanceTimersByTimeAsync(2000) })
    expect(boundary.recover).toHaveBeenCalledOnce()
})

it('refreshes derived inputs for daily source changes, independently of live scores', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { notifyLeagueChange('league', { topic: 'stat', scopes: null }); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.recover).not.toHaveBeenCalled()
    await act(async () => { notifyLeagueChange('league', { topic: 'resources', scopes: null, details: [{ resource: 'averages', season_id: seasonId }] }); await vi.advanceTimersByTimeAsync(200) })
    expect(boundary.recover).toHaveBeenCalledOnce()
})

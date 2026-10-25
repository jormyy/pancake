import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLeagueAnnouncements } from '@/hooks/use-league-announcements'
import { notifyLeagueChange } from '@/lib/league-changes'
import { listLeagueAnnouncements } from '@/lib/league-announcements'

const rpc = vi.hoisted(() => vi.fn())
const route = vi.hoisted(() => ({ focused: true }))
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react')
    return { useFocusEffect: (callback: React.EffectCallback) => ReactModule.useEffect(() => route.focused ? callback() : undefined, [callback, route.focused]) }
})
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useLeagueAnnouncements>
const Probe = ({ league = 'league', enabled = true }: { league?: string; enabled?: boolean }) => { latest = useLeagueAnnouncements('owner', league, enabled); return null }
beforeEach(() => { route.focused = true; rpc.mockReset().mockResolvedValue({ data: [], error: null }) })
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals(); vi.useRealTimers() })

it('calls the existing announcement RPC with its exact named argument', async () => {
    await expect(listLeagueAnnouncements('league')).resolves.toEqual([])
    expect(rpc).toHaveBeenCalledExactlyOnceWith('notif_list_announcements', { p_league_id: 'league' })
})

it('waits for the announcement read before revealing and keeps its result stable after first load', async () => {
    let finish!: (value: unknown) => void
    rpc.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(latest.loaded).toBe(false)
    await act(async () => finish({ data: [{ id: 'new', body: 'Draft tonight.' }], error: null }))
    expect(latest.loaded).toBe(true)
    expect(latest.announcements[0].body).toBe('Draft tonight.')
    await act(async () => screen.update(React.createElement(Probe)))
    expect(rpc).toHaveBeenCalledOnce()
})

it('drops a late former-league response and defers reads until authorized', async () => {
    let finish!: (value: unknown) => void
    rpc.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => { screen = create(React.createElement(Probe, { enabled: false })) })
    expect(rpc).not.toHaveBeenCalled()
    await act(async () => screen.update(React.createElement(Probe)))
    await act(async () => screen.update(React.createElement(Probe, { league: 'new-league' })))
    await act(async () => finish({ data: [{ id: 'private-old-league' }], error: null }))
    expect(latest.announcements).toEqual([])
    expect(latest.loaded).toBe(true)
})

it('allows Home content to render if the announcement read fails', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') })
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(latest.loaded).toBe(true)
    expect(latest.announcements).toEqual([])
})

it('refreshes Home announcements on focus and pull without clearing the last banner', async () => {
    const saved = [{ id: 'saved', body: 'Saved announcement' }]
    rpc.mockResolvedValueOnce({ data: saved, error: null })
    await act(async () => { screen = create(React.createElement(Probe)) })
    route.focused = false
    await act(async () => screen.update(React.createElement(Probe)))
    let finish!: (value: unknown) => void
    rpc.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    route.focused = true
    await act(async () => screen.update(React.createElement(Probe)))
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(latest.loaded).toBe(true)
    expect(latest.announcements).toEqual(saved)
    await act(async () => finish({ data: [{ id: 'new', body: 'New announcement' }], error: null }))
    expect(latest.announcements[0].body).toBe('New announcement')
    rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') })
    await act(async () => { await latest.refresh() })
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(latest.loaded).toBe(true)
    expect(latest.announcements[0].body).toBe('New announcement')
})

it('refreshes Home announcements after browser foreground without resetting readiness', async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('document', page)
    rpc.mockResolvedValueOnce({ data: [{ id: 'saved' }], error: null }).mockResolvedValueOnce({ data: [{ id: 'fresh' }], error: null })
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => { page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange')) })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(latest.loaded).toBe(true)
    expect(latest.announcements[0].id).toBe('fresh')
})

it.each([
    { topic: 'roster' as const, scopes: null },
    { topic: 'inventory' as const, scopes: null, details: [{ resource: 'season' as const, season_id: 'season' }] },
    { topic: 'catchup' as const, scopes: null },
])('refreshes Home announcements on surviving $topic hints', async change => {
    vi.useFakeTimers()
    rpc.mockResolvedValueOnce({ data: [{ id: 'saved' }], error: null }).mockResolvedValueOnce({ data: [{ id: 'fresh' }], error: null })
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => { notifyLeagueChange('league', change); await vi.advanceTimersByTimeAsync(200) })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(latest.loaded).toBe(true)
    expect(latest.announcements[0].id).toBe('fresh')
})

it('refreshes on browser focus only while Home is focused', async () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    rpc.mockResolvedValueOnce({ data: [{ id: 'before' }], error: null }).mockResolvedValueOnce({ data: [{ id: 'focused' }], error: null })
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => { browser.dispatchEvent(new Event('focus')) })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(latest.announcements[0].id).toBe('focused')
    route.focused = false
    await act(async () => screen.update(React.createElement(Probe)))
    await act(async () => { browser.dispatchEvent(new Event('focus')) })
    expect(rpc).toHaveBeenCalledTimes(2)
})

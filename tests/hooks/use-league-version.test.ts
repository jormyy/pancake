import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:59121/functions/v1/api' }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'local' } } }) } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
let useLeagueVersion: typeof import('@/hooks/use-league-version').useLeagueVersion
let versions: typeof import('@/lib/league-version')
let result: ReturnType<typeof useLeagueVersion>
const Probe = ({ league = 'one', user = 'user', validated = true }) => { result = useLeagueVersion(league, user, validated); return null }
const data = (version: string) => ({ version, changes: [{ version, topic: 'roster', scope: {}, created_at: '2026-11-02' }] })
beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(data('1'))))
    ;({ useLeagueVersion } = await import('@/hooks/use-league-version'))
    versions = await import('@/lib/league-version')
})
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals() })

it('reads the initial version, receives shared changes, and removes its listener', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(result.version).toBe('1')
    await act(async () => { versions.applyLeagueVersion('one', data('2')) })
    expect(result.version).toBe('2')
    act(() => renderer?.unmount()); renderer = undefined
    versions.applyLeagueVersion('one', data('3'))
    expect(result.version).toBe('2')
})

it('does not read for unvalidated membership or keep another league version', async () => {
    await act(async () => { renderer = create(React.createElement(Probe, { validated: false })) })
    expect(fetch).not.toHaveBeenCalled()
    expect(result.version).toBe('0')
    await act(async () => { renderer!.update(React.createElement(Probe)) })
    expect(result.version).toBe('1')
    await act(async () => { renderer!.update(React.createElement(Probe, { league: 'two', validated: false })) })
    expect(result.version).toBe('0')
})

it('preserves a newer push while an earlier read finishes', async () => {
    let release!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve })))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { versions.applyLeagueVersion('one', data('8')); release(Response.json(data('7'))) })
    expect(result.version).toBe('8')
})

it('reports failed reads and retries on reconnect without polling', async () => {
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json(data('2'))))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(result.error?.message).toBe('offline')
    await act(async () => { events.dispatchEvent(new Event('online')) })
    expect(result.version).toBe('2')
    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
})

it('reopens the same league after the same account starts a new session', async () => {
    const sessions = await import('@/lib/session-cache-registry')
    sessions.setSessionOwner('user')
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { versions.applyLeagueVersion('one', data('8')) })
    expect(result.version).toBe('8')
    sessions.setSessionOwner(null)
    sessions.setSessionOwner('user')
    await act(async () => { renderer!.update(React.createElement(Probe)) })
    expect(result.version).toBe('1')
    expect(fetch).toHaveBeenCalledTimes(2)
})

it('keeps receiving versions after caches clear without an account change', async () => {
    const sessions = await import('@/lib/session-cache-registry')
    sessions.setSessionOwner('user')
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { versions.applyLeagueVersion('one', data('8')) })
    await act(async () => { sessions.clearSessionCaches() })
    const stream = await import('@/lib/league-changes')
    await act(async () => { stream.notifyLeagueChange('one', { topic: 'version', scopes: null, version: '9', changes: data('9').changes }) })
    expect(result.version).toBe('9')
    await act(async () => { result.refresh() })
    expect(result.version).toBe('9')
})

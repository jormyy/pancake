import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:59121/functions/v1/api' }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'local' } } }) } } }))
let versions: typeof import('@/lib/league-version')
let stream: typeof import('@/lib/league-changes')
let sessions: typeof import('@/lib/session-cache-registry')
const change = (version: string) => ({ version, topic: 'roster', scope: { tables: ['roster_players'] }, created_at: '2026-11-02T00:00:00Z' })
beforeEach(async () => {
    vi.resetModules()
    vi.unstubAllGlobals()
    versions = await import('@/lib/league-version')
    stream = await import('@/lib/league-changes')
    sessions = await import('@/lib/session-cache-registry')
})

it('compares exact bigint counters and rejects unsafe numbers and malformed values', () => {
    expect(versions.compareLeagueVersions('9007199254740993', '9007199254740992')).toBe(1)
    expect(versions.compareLeagueVersions('7', '7')).toBe(0)
    expect(versions.compareLeagueVersions('7', '8')).toBe(-1)
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '1e2', '9223372036854775808', null]) {
        expect(() => versions.normalizeLeagueVersion(value)).toThrow()
    }
})

it('deduplicates events across receiver resets and never lowers the applied version', () => {
    const listener = vi.fn()
    const stop = versions.subscribeLeagueVersion('league', listener)
    const receive = stream.leagueChangeReceiver('league', value => stream.notifyLeagueChange('league', value))
    const row = (version: string) => ({ league_id: 'league', topic: 'version', revision: Number(version), details: [change(version)], scopes: null })
    receive(row('9007199254740993'))
    receive(row('9007199254740993'))
    receive.reset()
    receive(row('9007199254740992'))
    receive(row('9007199254740994'))
    expect(listener.mock.calls.map(([value]) => value.version)).toEqual(['9007199254740993', '9007199254740994'])
    expect(versions.applyLeagueVersion('league', { version: '4', changes: [change('4')] }).version).toBe('9007199254740994')
    stop()
    receive(row('9007199254740995'))
    expect(listener).toHaveBeenCalledTimes(2)
})

it('does not accept malformed changes or changes above their response version', () => {
    for (const value of [
        { version: '3', changes: [change('4')] },
        { version: '3', changes: [change('2'), change('1')] },
        { version: '3', changes: [{ ...change('3'), scope: [] }] },
        { version: '3', changes: null },
    ]) expect(() => versions.applyLeagueVersion('league', value)).toThrow()
    expect(versions.leagueVersionSnapshot('league').version).toBe('0')
    expect(stream.leagueChangeReceiver('league', vi.fn())({ league_id: 'league', topic: 'version', details: [{ ...change('2'), version: 'bad' }] })).toBe(false)
})

it('returns the current version when an older HTTP response arrives after realtime', async () => {
    let release!: (response: Response) => void
    const request = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    vi.stubGlobal('fetch', request)
    const read = versions.readLeagueVersion('league')
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    versions.applyLeagueVersion('league', { version: '8', changes: [change('8')] })
    release(Response.json({ version: '7', changes: [change('7')] }))
    expect((await read).version).toBe('8')
    expect(request.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('/version?league=league&since=0')]))
})

it('rejects a late HTTP response after an account change and clears previous counters', async () => {
    sessions.setSessionOwner('one')
    let release!: (response: Response) => void
    const request = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    vi.stubGlobal('fetch', request)
    versions.applyLeagueVersion('league', { version: '5', changes: [change('5')] })
    const read = versions.readLeagueVersion('league')
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    sessions.setSessionOwner('two')
    release(Response.json({ version: '9', changes: [change('9')] }))
    await expect(read).rejects.toThrow('account changed')
    expect(versions.leagueVersionSnapshot('league').version).toBe('0')
})

it('rejects unauthorized HTTP replies without changing the cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Forbidden' }, { status: 403 })))
    await expect(versions.readLeagueVersion('league')).rejects.toThrow('Could not read')
    expect(versions.leagueVersionSnapshot('league').version).toBe('0')
})

it('keeps a persisted cursor when the server snapshot is older than since', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: '7', changes: [] })))
    expect((await versions.readLeagueVersion('league', '8')).version).toBe('8')
    expect(versions.leagueVersionSnapshot('league').changes[0].topic).toBe('catchup')
})

it('broadens a missing range instead of treating the last event as a complete change list', () => {
    versions.applyLeagueVersion('league', { version: '1', changes: [change('1')] })
    const snapshot = versions.applyLeagueVersion('league', { version: '4', changes: [change('4')] })
    expect(snapshot.changes).toEqual([{ ...change('4'), topic: 'catchup', scope: {} }])
})

it('keeps the applied counter and live listener when caches clear within one account', () => {
    sessions.setSessionOwner('user')
    const listener = vi.fn()
    versions.subscribeLeagueVersion('league', listener)
    versions.applyLeagueVersion('league', { version: '8', changes: [change('8')] })
    sessions.clearSessionCaches()
    expect(versions.leagueVersionSnapshot('league').version).toBe('8')
    stream.notifyLeagueChange('league', { topic: 'version', scopes: null, version: '7', changes: [change('7')] })
    stream.notifyLeagueChange('league', { topic: 'version', scopes: null, version: '9', changes: [change('9')] })
    expect(listener.mock.calls.at(-1)?.[0].version).toBe('9')
    expect(listener.mock.calls.map(([snapshot]) => snapshot.version)).not.toContain('7')
})

import { expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => {
    let receive: (event: unknown) => void = () => {}
    const channel = {
        on: vi.fn((_kind, _options, callback) => { receive = callback; return channel }),
        subscribe: vi.fn(() => channel),
    }
    return { channel: vi.fn(() => channel), removeChannel: vi.fn(async () => undefined), emit: (event: unknown) => receive(event) }
})

vi.mock('@/lib/supabase', () => ({ supabase: {
    channel: transport.channel,
    removeChannel: transport.removeChannel,
    auth: { getSession: async () => ({ data: { session: { access_token: 'local-test' } } }) },
} }))
vi.mock('@/lib/shared/api-url', () => ({ API_URL: 'http://127.0.0.1:62221/functions/v1/api' }))

import { leagueChangeReceiver, notifyLeagueChange } from '@/lib/league-changes'
import { leagueVersionSnapshot, readLeagueVersion, subscribeLeagueVersion } from '@/lib/league-version'
import { subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'

it('keeps Broadcast live while three version polls per minute race with hints', async () => {
    vi.useFakeTimers()
    const league = 'poll-compatibility'
    const updates = vi.fn()
    const stop = subscribeLeagueVersion(league, updates)
    const receive = leagueChangeReceiver(league, change => notifyLeagueChange(league, change))
    const handle = subscribeToTableChanges('poll-compatibility', { mode: 'per-watch', watches: [
        { table: 'league_change_hints', filter: `league_id=eq.${league}`, onChange: payload => { receive(payload.new) } },
    ] })
    const change = (version: string) => ({ version, topic: 'score', scope: {}, created_at: '2026-10-30T00:00:00Z' })
    const emit = (version: string) => transport.emit({ payload: { hints: [{ event: 'UPDATE', row: {
        topic: 'version', scopes: null, details: [change(version)],
    } }] } })
    const pending: ((response: Response) => void)[] = []
    const request = vi.fn(() => new Promise<Response>(resolve => { pending.push(resolve) }))
    vi.stubGlobal('fetch', request)
    const reads: Promise<unknown>[] = []
    const timer = setInterval(() => { reads.push(readLeagueVersion(league)) }, 20_000)
    try {
        emit('1')
        for (const [broadcast, polled] of [['2', '1'], ['3', '4'], ['5', '4']]) {
            await vi.advanceTimersByTimeAsync(20_000)
            emit(broadcast)
            pending.shift()!(Response.json({ version: polled, changes: [change(polled)] }))
            await reads.at(-1)
        }
        expect(request).toHaveBeenCalledTimes(3)
        expect(updates.mock.calls.map(([snapshot]) => snapshot.version)).toEqual(['1', '2', '3', '4', '5'])
        expect(leagueVersionSnapshot(league).version).toBe('5')
        expect(transport.channel).toHaveBeenCalledExactlyOnceWith(`l1:league:${league}`, { config: { private: true } })
        expect(transport.removeChannel).not.toHaveBeenCalled()
    } finally {
        clearInterval(timer)
        stop()
        await unsubscribeFromTableChanges(handle)
        vi.unstubAllGlobals()
        vi.useRealTimers()
    }
})

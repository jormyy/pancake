import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Status = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'

const socket = vi.hoisted(() => {
    const channels: { topic: string; report: (status: Status) => void }[] = []
    return {
        channels,
        channel: (topic: string) => {
            const entry = { topic, report: (_status: Status) => {} }
            const channel = {
                on: () => channel,
                subscribe: (callback: (status: Status) => void) => {
                    entry.report = callback
                    return channel
                },
            }
            channels.push(entry)
            return channel
        },
        removeChannel: async () => 'ok',
    }
})

vi.mock('@/lib/supabase', () => ({ supabase: { channel: socket.channel, removeChannel: socket.removeChannel } }))

import { subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'

const report = async (status: Status) => {
    socket.channels.at(-1)!.report(status)
    await vi.advanceTimersByTimeAsync(0)
}

const rooms = {
    'auction room': (draftId: string) => [
        { table: 'nominations', filter: `draft_id=eq.${draftId}` },
        { table: 'draft_budgets', filter: `draft_id=eq.${draftId}` },
        { table: 'drafts', event: 'UPDATE' as const, filter: `id=eq.${draftId}` },
    ],
    'rookie draft room': (draftId: string) => [
        { table: 'snake_draft_picks', filter: `draft_id=eq.${draftId}` },
        { table: 'drafts', event: 'UPDATE' as const, filter: `id=eq.${draftId}` },
    ],
    'unscoped feed': () => [{ table: 'nba_games' }],
}

beforeEach(() => {
    vi.useFakeTimers()
    socket.channels.length = 0
})

afterEach(() => {
    vi.useRealTimers()
})

describe.each(Object.entries(rooms))('%s channel the server closed', (room, watches) => {
    it('subscribes again and catches up without the screen asking', async () => {
        const onStatus = vi.fn()
        const onReconnect = vi.fn(async () => true)
        const handle = subscribeToTableChanges(room, { mode: 'fallback', watches: watches(room), onChange: vi.fn(), onStatus, onReconnect })
        await report('SUBSCRIBED')
        await report('CLOSED')
        expect(onStatus).toHaveBeenLastCalledWith('CLOSED')
        await vi.advanceTimersByTimeAsync(10_000)
        expect(socket.channels, 'A CLOSED channel never rejoins on its own. lib/realtime must open a new one; screens must not.').toHaveLength(2)
        await report('SUBSCRIBED')
        expect(onStatus).toHaveBeenLastCalledWith('SUBSCRIBED')
        expect(onReconnect).toHaveBeenCalledOnce()
        await unsubscribeFromTableChanges(handle)
    })

    it('stays closed once the screen unsubscribes', async () => {
        const handle = subscribeToTableChanges(room, { mode: 'fallback', watches: watches(`${room}-left`), onChange: vi.fn() })
        await report('SUBSCRIBED')
        await report('CLOSED')
        await unsubscribeFromTableChanges(handle)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(socket.channels).toHaveLength(1)
    })
})

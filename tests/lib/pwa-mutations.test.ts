import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, from, upload, prepare, complete, signIn } = vi.hoisted(() => ({
    rpc: vi.fn(), from: vi.fn(), upload: vi.fn(), prepare: vi.fn(), complete: vi.fn(), signIn: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ supabase: {
    rpc, from, storage: { from: () => ({ upload, getPublicUrl: () => ({ data: { publicUrl: 'http://localhost/avatar.png' } }) }) },
    auth: { signInWithPassword: signIn },
} }))
vi.mock('@/lib/web-push', () => ({ prepareWebPushLogin: prepare, completeWebPushLogin: complete }))

import { isPwaUpdateHeld } from '@/lib/pwa-update-guard'
import { addFreeAgent, getRoster } from '@/lib/roster'
import { signIn as logIn, uploadAvatar } from '@/lib/auth'
import { setLineupOptimizerEnabled } from '@/lib/lineup/optimizerSettings'
import { createNotificationPreferenceWriter } from '@/lib/notification-preferences'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('navigator', { onLine: true })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

describe('direct client write update protection', () => {
    it.each([
        [undefined, null], [false, null], [true, null],
        [undefined, { code: 'P0001', message: 'Roster full' }],
        [false, { code: 'P0001', message: 'Roster full' }],
        [true, { code: 'P0001', message: 'Roster full' }],
    ] as const)('holds a roster RPC through settlement (IR=%s, error=%j)', async (toIr, error) => {
        const reply = deferred<{ error: typeof error }>()
        rpc.mockReturnValue(reply.promise)
        const request = addFreeAgent('member', 'league', 'player', toIr)
        expect(isPwaUpdateHeld()).toBe(true)
        expect(rpc).toHaveBeenCalledWith('add_free_agent_atomic', {
            p_member_id: 'member', p_league_id: 'league', p_player_id: 'player', p_to_ir: toIr ?? false, p_to_taxi: false,
        })
        const result = error ? expect(request).rejects.toThrow('Roster full') : expect(request).resolves.toBeUndefined()
        reply.resolve({ error })
        await result
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it('keeps Storage upload and profile commit in one protected operation', async () => {
        const stored = deferred<{ error: null }>(), profile = deferred<{ error: null }>()
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }))))
        upload.mockReturnValue(stored.promise)
        const eq = vi.fn(() => profile.promise)
        const update = vi.fn(() => ({ eq }))
        from.mockReturnValue({ update })
        const request = uploadAvatar('owner', { uri: 'blob:photo', width: 10, height: 10 })
        expect(isPwaUpdateHeld()).toBe(true)
        await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())
        stored.resolve({ error: null })
        await vi.waitFor(() => expect(eq).toHaveBeenCalledWith('id', 'owner'))
        expect(isPwaUpdateHeld()).toBe(true)
        profile.resolve({ error: null })
        expect(await request).toMatch(/^http:\/\/localhost\/avatar.png\?t=\d+$/)
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it('releases after a failed direct table write', async () => {
        const response = deferred<{ error: Error }>()
        rpc.mockReturnValue(response.promise)
        const request = setLineupOptimizerEnabled('member', 'league', 'season', true)
        const result = expect(request).rejects.toThrow('denied')
        expect(isPwaUpdateHeld()).toBe(true)
        response.resolve({ error: new Error('denied') })
        await result
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it('protects login through notification registration', async () => {
        prepare.mockResolvedValue(null)
        signIn.mockResolvedValue({ data: { session: { user: { id: 'owner' } } }, error: null })
        const registered = deferred<void>()
        complete.mockReturnValue(registered.promise)
        const request = logIn('owner@example.test', 'password')
        expect(isPwaUpdateHeld()).toBe(true)
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
        expect(isPwaUpdateHeld()).toBe(true)
        registered.resolve()
        await request
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it('protects queued preference intent before its write starts', async () => {
        const first = deferred<void>(), second = deferred<void>()
        const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const writer = createNotificationPreferenceWriter(write)
        const preferences = { tradeEnabled: true, waiverEnabled: true, draftEnabled: true, activityEnabled: true }
        const a = writer.enqueue(preferences), b = writer.enqueue(preferences)
        expect(isPwaUpdateHeld()).toBe(true)
        await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
        first.resolve()
        await a
        expect(isPwaUpdateHeld()).toBe(true)
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
        second.resolve()
        await b
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it('does not hold an ordinary roster read', async () => {
        const response = deferred<{ data: never[]; error: null }>()
        const chain = { select: () => chain, in: () => chain, eq: () => chain, order: vi.fn() }
        chain.order.mockReturnValueOnce(chain).mockReturnValueOnce(response.promise)
        from.mockReturnValue(chain)
        const request = getRoster('member', 'league', 'season')
        expect(isPwaUpdateHeld()).toBe(false)
        response.resolve({ data: [], error: null })
        expect(await request).toEqual([])
    })
})

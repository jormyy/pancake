import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}))

import { apiPost, resolveDefaultApiUrl } from '@/lib/shared/api'
import { supabase } from '@/lib/supabase'
import { isPwaUpdateHeld } from '@/lib/pwa-update-guard'

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('resolveDefaultApiUrl', () => {
    it('prefers the Supabase Edge API over a stale explicit API URL', () => {
        expect(resolveDefaultApiUrl({
            configuredApiUrl: 'https://pancake-production-65f8.up.railway.app',
            configuredSupabaseUrl: 'https://ceeytbfmwsnzalxlkalc.supabase.co/',
        })).toBe('https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/api')
    })

    it('falls back to the explicit API URL when Supabase is not configured', () => {
        expect(resolveDefaultApiUrl({
            configuredApiUrl: 'https://api.example.test/functions/v1/api',
            configuredSupabaseUrl: undefined,
        })).toBe('https://api.example.test/functions/v1/api')
    })

    it('requires either a Supabase URL or explicit API URL', () => {
        expect(() => resolveDefaultApiUrl({
            configuredApiUrl: undefined,
            configuredSupabaseUrl: undefined,
        })).toThrow('EXPO_PUBLIC_API_URL or EXPO_PUBLIC_SUPABASE_URL is required.')
    })
})

describe('apiPost timeout lifecycle', () => {
    it('clears the deadline after a successful request', async () => {
        vi.useFakeTimers()
        vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null })
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))

        await expect(apiPost('/test', {})).resolves.toEqual({ ok: true })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('times out when session lookup stalls', async () => {
        vi.useFakeTimers()
        vi.mocked(supabase.auth.getSession).mockReturnValue(new Promise(() => {}))
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        const request = apiPost('/test', {}, { timeoutMs: 25 })
        const result = expect(request).rejects.toThrow('Request timed out after 25ms')
        await vi.advanceTimersByTimeAsync(25)

        await result
        expect(fetchMock).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('times out when response body parsing stalls', async () => {
        vi.useFakeTimers()
        vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null })
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: () => new Promise(() => {}),
        })))

        const request = apiPost('/test', {}, { timeoutMs: 25 })
        const result = expect(request).rejects.toThrow('Request timed out after 25ms')
        await vi.advanceTimersByTimeAsync(25)

        await result
        expect(vi.getTimerCount()).toBe(0)
    })
})

describe('apiPost account binding', () => {
    it('uses one generated ID in the body and headers when a trade response is lost', async () => {
        vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null })
        const send = vi.fn().mockRejectedValueOnce(new TypeError('Lost')).mockResolvedValueOnce(Response.json({ ok: true }))
        vi.stubGlobal('fetch', send)
        await apiPost('/trades/propose', {})
        expect(send).toHaveBeenCalledTimes(2)
        const first = send.mock.calls[0][1] as RequestInit
        const second = send.mock.calls[1][1] as RequestInit
        expect(first.body).toBe(second.body)
        const id = JSON.parse(first.body as string).requestId
        expect(id).toMatch(/^[0-9a-f-]{36}$/)
        expect(new Headers(first.headers).get('x-request-id')).toBe(id)
        expect(new Headers(second.headers).get('x-request-id')).toBe(id)
    })

    it('rejects a changed session before sending an account-bound request', async () => {
        vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null })
        const send = vi.fn()
        vi.stubGlobal('fetch', send)
        await expect(apiPost('/bound', {}, { expectedUserId: 'owner-a' })).rejects.toThrow('account changed')
        expect(send).not.toHaveBeenCalled()
    })

    it('checks shared admission after session lookup and before HTTP dispatch', async () => {
        vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null })
        const send = vi.fn()
        const beforeSend = vi.fn(async () => { throw new Error('shared logout closed') })
        vi.stubGlobal('fetch', send)
        await expect(apiPost('/bound', {}, { beforeSend })).rejects.toThrow('shared logout closed')
        expect(beforeSend).toHaveBeenCalledOnce()
        expect(send).not.toHaveBeenCalled()
    })
})


describe('pending API update protection', () => {
    it('holds through session admission and the complete response body', async () => {
        vi.stubGlobal('window', new EventTarget())
        let admit!: (value: Awaited<ReturnType<typeof supabase.auth.getSession>>) => void
        vi.mocked(supabase.auth.getSession).mockReturnValue(new Promise(resolve => { admit = resolve }))
        let finish!: (value: unknown) => void
        const body = new Promise(resolve => { finish = resolve })
        const send = vi.fn(async () => new Response(new ReadableStream({
            async start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify(await body)))
                controller.close()
            },
        }), { headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', send)
        const request = apiPost('/league/roster/taxi', {})
        try {
            expect(isPwaUpdateHeld()).toBe(true)
            admit({ data: { session: null }, error: null })
            await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
            expect(isPwaUpdateHeld()).toBe(true)
        } finally {
            admit({ data: { session: null }, error: null })
            finish({ ok: true })
            await request
        }
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it.each(['network', 'server', 'json', 'admission'])('releases after %s failure', async mode => {
        vi.stubGlobal('window', new EventTarget())
        vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null })
        vi.stubGlobal('fetch', vi.fn(async () => {
            expect(isPwaUpdateHeld()).toBe(true)
            if (mode === 'network') throw new Error('network failed')
            return { ok: mode !== 'server', status: 400, json: async () => {
                if (mode === 'json') throw new Error('json failed')
                return { error: 'server failed' }
            } }
        }))
        await expect(apiPost('/write', {}, { beforeSend: async () => {
            expect(isPwaUpdateHeld()).toBe(true)
            if (mode === 'admission') throw new Error('admission failed')
        } })).rejects.toThrow(`${mode} failed`)
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it('releases a timed-out request without releasing an overlapping write', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('window', new EventTarget())
        vi.mocked(supabase.auth.getSession).mockReturnValue(new Promise(() => {}))
        const first = apiPost('/first', {}, { timeoutMs: 25 })
        const second = apiPost('/second', {}, { timeoutMs: 50 })
        const firstResult = expect(first).rejects.toThrow('25ms')
        const secondResult = expect(second).rejects.toThrow('50ms')
        expect(isPwaUpdateHeld()).toBe(true)
        await vi.advanceTimersByTimeAsync(25)
        await firstResult
        expect(isPwaUpdateHeld()).toBe(true)
        await vi.advanceTimersByTimeAsync(25)
        await secondResult
        expect(isPwaUpdateHeld()).toBe(false)
    })
})

it.each([
    { error: 'The season has started. The schedule cannot be rebuilt.' },
    { ok: false, error: 'The season has started. The schedule cannot be rebuilt.', code: 'schedule_started', requestId: 'request' },
])('shows the real Edge schedule conflict shape on HTTP 409: %j', async body => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } })))
    await expect(apiPost('/sync/matchups', { force: true, leagueId: 'league' })).rejects.toThrow(body.error)
})

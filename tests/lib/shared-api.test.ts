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

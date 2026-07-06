import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}))

import { resolveDefaultApiUrl } from '@/lib/shared/api'

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

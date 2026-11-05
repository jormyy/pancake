import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ status: 0, url: 'http://127.0.0.1:59821', spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => { state.spawn(...args); return { status: state.status } } }))
vi.mock('./e2e/env.mjs', () => ({ resolvedEnv: () => ({ supabaseUrl: state.url, anonKey: 'local-public-fixture' }), requireEnv: (value: unknown) => value }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); state.status = 0; state.url = 'http://127.0.0.1:59821' })
afterEach(() => vi.unstubAllEnvs())

it('overrides inherited frontend settings and disables predecessor recovery', async () => {
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://example.invalid')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PANCAKE_FETCH_PREDECESSOR', '1')
    vi.stubEnv('PANCAKE_PREVIOUS_RELEASE_ROOT', '/unused')
    await import('./e2e/navigation-release.mjs')
    const options = state.spawn.mock.calls[0][2]
    expect(options.env.EXPO_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:59821')
    expect(options.env.EXPO_PUBLIC_API_URL).toBe('http://127.0.0.1:59821/functions/v1/api')
    expect(options.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe('local-public-fixture')
    expect(options.env.PANCAKE_PREVIOUS_RELEASE_ROOT).toBe('')
    expect(options.env.VERCEL_ENV).toBe('development')
    expect(options.env.PANCAKE_FETCH_PREDECESSOR).toBe('0')
})

it('propagates a release build failure', async () => {
    state.status = 1
    await expect(import('./e2e/navigation-release.mjs')).rejects.toThrow('must finish')
    expect(state.spawn).toHaveBeenCalledTimes(1)
})

it.each(['https://example.invalid', 'http://127.0.0.1:54321'])('rejects a non-lane target %s before launching the build', async url => {
    state.url = url
    await expect(import('./e2e/navigation-release.mjs')).rejects.toThrow()
    expect(state.spawn).not.toHaveBeenCalled()
})

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { auditWebAuthActions } from './e2e/web-targets-auth-actions.mjs'

vi.mock('./e2e/trade-fixture.mjs', () => ({
    setupTradeGameplayFixture: async () => ({ admin: {} }),
    createFixtureResourceOwner: () => ({ registerUser: vi.fn() }),
}))
vi.mock('./e2e/web-targets-browser.mjs', () => ({ waitForWebAuthForm: async (page: { waitForFunction: () => Promise<void> }) => page.waitForFunction(), navigateWebTarget: async (page: { goto: (url: string) => Promise<void> }, url: string) => page.goto(url) }))

describe('signup action hydration', () => {
    it('fills the hydrated form before Return and keeps the one-request assertion', async () => {
        let hydrated = false
        const fields = new Map<string, string>()
        const fills: { name: string; hydrated: boolean }[] = []
        const requests: string[] = []
        const stop = new Error('Stop after signup receipt')
        const page = Object.assign(new EventEmitter(), {
            evaluate: vi.fn(),
            goto: vi.fn(),
            waitForFunction: async () => { hydrated = true },
            getByPlaceholder: (name: string) => ({
                fill: async (value: string) => { fills.push({ name, hydrated }); fields.set(name, hydrated ? value : '') },
                focus: vi.fn(),
            }),
            keyboard: { press: async () => {
                if ([...fields.values()].some((value) => !value) || requests.length) return
                requests.push('signup')
                page.emit('request', { url: () => '/auth/v1/signup', method: () => 'POST' })
            } },
            waitForResponse: async () => ({ status: () => 200, json: async () => ({ id: 'new-user' }) }),
            getByRole: () => ({ waitFor: async () => { throw stop } }),
        })
        await expect(auditWebAuthActions({
            check: async (name: string, run: () => Promise<void>) => name === 'signup-password-signout' ? run() : undefined,
            env: { frontendUrl: 'http://127.0.0.1:8082' }, season: 0, page,
            signIn: vi.fn(), press: vi.fn(), button: vi.fn(), open: vi.fn(), db: vi.fn(), wait: vi.fn(),
        })).rejects.toBe(stop)
        expect(fills).toHaveLength(4)
        expect(fills.every((field) => field.hydrated)).toBe(true)
        expect(fields.get('Maple Manager')).toBe('Web Action Manager')
        expect(requests).toEqual(['signup'])
        expect(page.listenerCount('request')).toBe(0)
    })
})

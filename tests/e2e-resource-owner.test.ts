import { describe, expect, it, vi } from 'vitest'
import { createScenarioResourceOwner } from './e2e/scenario-resource-owner.mjs'
import { createDisposableLeagueFromSeedUsers } from './e2e/soak-fixtures.mjs'

describe('scenario resource ownership', () => {
    it('disposes in reverse acquisition order and aggregates every failure', async () => {
        const calls: string[] = []
        const owner = createScenarioResourceOwner('scenario')
        owner.register('first', async () => {
            calls.push('first')
            throw new Error('first failed')
        })
        owner.register('second', async () => {
            calls.push('second')
            throw new Error('second failed')
        })

        await expect(owner.dispose()).rejects.toMatchObject({
            errors: [expect.any(Error), expect.any(Error)],
        })
        expect(calls).toEqual(['second', 'first'])
    })

    it('rejects disposable fixture creation without an owner before touching the database', async () => {
        const from = vi.fn()
        await expect(createDisposableLeagueFromSeedUsers({
            supabase: { from },
            state: { password: 'password', users: [{ id: 'user' }] },
            season: 1,
            label: 'fixture',
            userCount: 1,
            resourceOwner: undefined,
        })).rejects.toThrow('requires a scenario resource owner')
        expect(from).not.toHaveBeenCalled()
    })
})

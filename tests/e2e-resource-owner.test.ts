import { describe, expect, it, vi } from 'vitest'
import {
    createScenarioResourceOwner,
    ownScenarioResource,
    releaseScenarioResource,
    runWithScenarioResourceOwner,
} from './e2e/scenario-resource-owner.mjs'
import { createDisposableLeagueFromSeedUsers, disposeDisposableLeague } from './e2e/soak-fixtures.mjs'

describe('scenario resource ownership', () => {
    it('rejects ambient registration when no scenario owner is active', () => {
        expect(() => ownScenarioResource('resource', 'unowned resource', async () => undefined))
            .toThrow('without an active scenario resource owner')
    })

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

    it('preserves nested cleanup failures in the owning resource error', async () => {
        const owner = createScenarioResourceOwner('scenario')
        owner.register('fixture', async () => {
            throw new AggregateError([
                new Error('league delete failed'),
                new Error('user delete failed'),
            ], 'fixture cleanup failed')
        })

        await expect(owner.dispose()).rejects.toMatchObject({
            errors: [expect.objectContaining({
                message: 'fixture: fixture cleanup failed: league delete failed: user delete failed',
            })],
        })
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

    it('makes the ambient owner the only cleanup executor for registered scenarios', async () => {
        const calls: string[] = []
        await runWithScenarioResourceOwner('browser scenario', async () => {
            ownScenarioResource('browser:session', 'browser session', async () => { calls.push('owned browser close') })
            ownScenarioResource('fixture:1', 'fixture', async () => { calls.push('owned fixture dispose') })
            expect(calls).toEqual([])
            return { status: 'PASS' }
        })

        expect(calls).toEqual(['owned fixture dispose', 'owned browser close'])
    })

    it('reacquires a browser session after an explicit lifecycle close', async () => {
        const calls: string[] = []
        await runWithScenarioResourceOwner('league lifecycle', async () => {
            ownScenarioResource('browser:league', 'commissioner browser', async () => { calls.push('close commissioner') })
            releaseScenarioResource('browser:league')
            ownScenarioResource('browser:league', 'manager browser', async () => { calls.push('close manager') })
            return { status: 'PASS' }
        })

        expect(calls).toEqual(['close manager'])
    })

    it('deletes draft dependencies before disposing a league', async () => {
        const calls: string[] = []
        const query = (table: string, operation: string) => {
            const builder = {
                eq: () => builder,
                then: (resolve: (value: { error: null }) => void) => {
                    calls.push(`${table}:${operation}`)
                    resolve({ error: null })
                },
            }
            return builder
        }
        const supabase = {
            from: (table: string) => ({
                update: () => query(table, 'update'),
                delete: () => query(table, 'delete'),
            }),
        }

        await disposeDisposableLeague(supabase, 'league-id', 'fixture')
        expect(calls).toEqual(['trades:update', 'drafts:delete', 'leagues:delete'])
    })
})

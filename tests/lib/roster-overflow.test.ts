import { describe, expect, it } from 'vitest'
import { activeRosterOverflow, createRosterRecoveryRunner } from '@/lib/roster-overflow'

describe('active roster overflow', () => {
    it.each([
        [20, 20, 0],
        [22, 20, 2],
        [18, 20, 0],
        [1, 0, 1],
    ])('maps %i active against a %i-player cap to %i excess', (active, cap, expected) => {
        expect(activeRosterOverflow(active, cap)).toBe(expected)
    })

    it('serializes same-turn recovery mutations and releases ownership afterward', async () => {
        const runRecovery = createRosterRecoveryRunner()
        let finishFirst!: () => void
        const firstRecovery = new Promise<void>((resolve) => { finishFirst = resolve })
        const calls: string[] = []

        const first = runRecovery(async () => { calls.push('first'); await firstRecovery })
        const blocked = await runRecovery(async () => { calls.push('second') })
        expect(blocked).toBe(false)
        expect(calls).toEqual(['first'])

        finishFirst()
        await expect(first).resolves.toBe(true)
        await expect(runRecovery(async () => { calls.push('third') })).resolves.toBe(true)
        expect(calls).toEqual(['first', 'third'])
    })
})

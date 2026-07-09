import { describe, expect, it } from 'vitest'

describe('canonical database function sources', () => {
    it('match the latest Supabase migration definitions', async () => {
        const { checkFunctionSources } = await import('../scripts/check-db-function-sources.mjs')

        expect(await checkFunctionSources()).toEqual([])
    })

    it('excludes functions whose latest migration event is a drop', async () => {
        const { latestFunctionDefinitions, latestFunctionDefinition } = await import('../scripts/check-db-function-sources.mjs')

        expect((await latestFunctionDefinitions()).has('public.is_username_available')).toBe(false)
        await expect(latestFunctionDefinition('public', 'is_username_available')).rejects.toThrow(/dropped after its latest definition/)
    })
})

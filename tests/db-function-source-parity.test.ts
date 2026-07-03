import { describe, expect, it } from 'vitest'

describe('canonical database function sources', () => {
    it('match the latest Supabase migration definitions', async () => {
        const { checkFunctionSources } = await import('../scripts/check-db-function-sources.mjs')

        expect(await checkFunctionSources()).toEqual([])
    })
})

import { describe, expect, it } from 'vitest'

import { scanLocalSecrets } from './e2e/local-secret-scan.mjs'

describe('local ignored secret scan', () => {
    it('does not keep active Supabase service-role JWTs in env files', () => {
        expect(scanLocalSecrets()).toEqual([])
    })
})

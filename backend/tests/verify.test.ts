import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
    supabase: { from: vi.fn() },
}))

vi.mock('../src/lib/nba', () => ({
    fetchBoxScore: vi.fn(),
}))

import { supabase } from '../src/lib/supabase'
import { validateDatabase, verifySampleStats, verifySeasonTotals } from '../src/sync/verify'

const mockFrom = vi.mocked(supabase.from)

function q(data: any = null, error: any = null, count: number | null = null) {
    const result = { data, error, count }
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        range: () => chain,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    }
    return chain
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('sync verification query failures', () => {
    it('fails validateDatabase when a count query errors', async () => {
        mockFrom.mockReturnValueOnce(q(null, { message: 'permission denied' }) as any)

        await expect(validateDatabase(2026)).rejects.toThrow('[verify] nba_games total count: permission denied')
    })

    it('fails verifySeasonTotals when a paged stats query errors', async () => {
        mockFrom.mockReturnValueOnce(q(null, { message: 'invalid api key' }) as any)

        await expect(verifySeasonTotals(2026)).rejects.toThrow('[verify] season totals page lookup: invalid api key')
    })

    it('fails verifySampleStats when the final-game sample query errors', async () => {
        mockFrom.mockReturnValueOnce(q(null, { message: 'JWT expired' }) as any)

        await expect(verifySampleStats(1)).rejects.toThrow('[verify] final game sample lookup: JWT expired')
    })
})

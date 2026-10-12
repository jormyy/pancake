import { afterEach, describe, expect, it, vi } from 'vitest'

const { from, upsert } = vi.hoisted(() => ({ from: vi.fn(), upsert: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from } }))

import { setLineupOptimizerEnabled } from '@/lib/lineup/optimizerSettings'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetAllMocks()
})

describe('season optimizer authority', () => {
    it.each([true, false])('rejects offline intent without creating a deferred write: %s', async enabled => {
        vi.stubGlobal('navigator', { onLine: false })
        await expect(setLineupOptimizerEnabled('member', 'league', 'season', enabled))
            .rejects.toThrow('Connect to the internet')
        vi.stubGlobal('navigator', { onLine: true })
        await Promise.resolve()
        expect(from).not.toHaveBeenCalled()
    })

    it('preserves the online tuple and propagates server rejection', async () => {
        vi.stubGlobal('navigator', { onLine: true })
        const error = { message: 'permission denied', code: '42501' }
        upsert.mockResolvedValue({ error })
        from.mockReturnValue({ upsert })
        await expect(setLineupOptimizerEnabled('member', 'league', 'season', false)).rejects.toBe(error)
        expect(upsert).toHaveBeenCalledWith({
            member_id: 'member', league_id: 'league', league_season_id: 'season',
            enabled: false, enabled_at: null,
        }, { onConflict: 'league_id,league_season_id,member_id' })
    })
})

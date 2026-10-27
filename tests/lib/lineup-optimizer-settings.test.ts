import { afterEach, describe, expect, it, vi } from 'vitest'

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from, rpc } }))

import { setLineupOptimizerEnabled } from '@/lib/lineup/optimizerSettings'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetAllMocks()
})

describe('season optimizer authority', () => {
    it.each([true, false])('passes offline intent to the guarded mutation transport: %s', async enabled => {
        vi.stubGlobal('navigator', { onLine: false })
        rpc.mockResolvedValue({ error: null })
        await expect(setLineupOptimizerEnabled('member', 'league', 'season', enabled)).resolves.toBeUndefined()
        expect(from).not.toHaveBeenCalled()
        expect(rpc).toHaveBeenCalledWith('save_client_settings_atomic', {
            p_kind: 'lineup_optimizer',
            p_settings: { memberId: 'member', leagueId: 'league', seasonId: 'season', enabled },
        })
    })

    it('preserves the online tuple and propagates server rejection', async () => {
        vi.stubGlobal('navigator', { onLine: true })
        const error = { message: 'permission denied', code: '42501' }
        rpc.mockResolvedValue({ error })
        await expect(setLineupOptimizerEnabled('member', 'league', 'season', false)).rejects.toBe(error)
        expect(rpc).toHaveBeenCalledWith('save_client_settings_atomic', {
            p_kind: 'lineup_optimizer',
            p_settings: { memberId: 'member', leagueId: 'league', seasonId: 'season', enabled: false },
        })
    })
})

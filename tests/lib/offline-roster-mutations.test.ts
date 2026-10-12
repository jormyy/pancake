import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropPlayer } from '@/lib/roster'
import { submitWaiverClaim } from '@/lib/waivers'

const { rpc, apiPost } = vi.hoisted(() => ({ rpc: vi.fn(), apiPost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/lib/shared/api', () => ({ apiPost }))

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

describe('offline roster mutation admission', () => {
    it.each(['drop', 'claim'])('rejects %s at call time, including a callback captured online', async (action) => {
        const network = { onLine: true }
        vi.stubGlobal('navigator', network)
        const confirm = action === 'drop'
            ? () => dropPlayer('roster')
            : () => submitWaiverClaim('member', 'league', 'player', 'drop', { bidAmount: 3 })
        network.onLine = false
        await expect(confirm()).rejects.toThrow('Connect to the internet')
        expect(rpc).not.toHaveBeenCalled()
        expect(apiPost).not.toHaveBeenCalled()
        network.onLine = true
        await Promise.resolve()
        expect(rpc).not.toHaveBeenCalled()
        expect(apiPost).not.toHaveBeenCalled()
        rpc.mockResolvedValue({ error: null })
        apiPost.mockResolvedValue(undefined)
        await confirm()
        expect(action === 'drop' ? rpc : apiPost).toHaveBeenCalledOnce()
    })

    it('keeps the exact online drop contract and server denial', async () => {
        vi.stubGlobal('navigator', { onLine: true })
        const error = { code: '42501', message: 'permission denied' }
        rpc.mockResolvedValue({ error })
        await expect(dropPlayer('roster')).rejects.toEqual(error)
        expect(rpc).toHaveBeenCalledWith('drop_player_atomic', { p_roster_player_id: 'roster' })
    })

    it('keeps the exact claim payload and failure for explicit retry', async () => {
        vi.stubGlobal('navigator', { onLine: true })
        apiPost.mockRejectedValueOnce(new Error('server unavailable')).mockResolvedValueOnce(undefined)
        const submit = () => submitWaiverClaim('member', 'league', 'player', 'drop', { bidAmount: 3, claimOrder: 2 })
        await expect(submit()).rejects.toThrow('server unavailable')
        expect(apiPost).toHaveBeenCalledOnce()
        await submit()
        expect(apiPost).toHaveBeenLastCalledWith('/waivers/claims', {
            memberId: 'member', leagueId: 'league', playerId: 'player', dropPlayerId: 'drop', bidAmount: 3, claimOrder: 2,
        })
    })

    it.each([undefined, {}])('preserves platforms without a browser offline signal (%j)', async (navigatorValue) => {
        vi.stubGlobal('navigator', navigatorValue)
        rpc.mockResolvedValue({ error: null })
        apiPost.mockResolvedValue(undefined)
        await dropPlayer('roster')
        await submitWaiverClaim('member', 'league', 'player')
        expect(rpc).toHaveBeenCalledOnce()
        expect(apiPost).toHaveBeenCalledOnce()
    })
})

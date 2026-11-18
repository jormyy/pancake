import { afterEach, expect, it, vi } from 'vitest'
import { optimizeLineupDate, setLineupPlayerPin } from '@/lib/lineup/pins'

const { rpc, apiPost } = vi.hoisted(() => ({ rpc: vi.fn(), apiPost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/lib/shared/api', () => ({ apiPost }))

afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals() })

it.each(['start', 'bench', null] as const)('writes the exact pin RPC contract: %s', async pin => {
    const result = { playerId: 'player', date: '2026-11-04', lineupPin: pin }
    rpc.mockResolvedValue({ data: result, error: null })
    await expect(setLineupPlayerPin('league', 'player', '2026-11-04', pin)).resolves.toEqual(result)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('set_lineup_player_pin', {
        p_league_id: 'league', p_player_id: 'player', p_date: '2026-11-04', p_pin: pin,
    })
})

it('rejects offline changes before sending the pin', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    await expect(setLineupPlayerPin('league', 'player', '2026-11-04', 'start')).rejects.toThrow('Connect to the internet')
    await expect(optimizeLineupDate('member', 'league', 'season', '2026-11-04')).rejects.toThrow('Connect to the internet')
    expect(rpc).not.toHaveBeenCalled()
    expect(apiPost).not.toHaveBeenCalled()
})

it('preserves server errors', async () => {
    const error = { message: 'This player is locked.' }
    rpc.mockResolvedValue({ error })
    await expect(setLineupPlayerPin('league', 'player', '2026-11-04', 'start')).rejects.toBe(error)
})

it('rejects an empty RPC response', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await expect(setLineupPlayerPin('league', 'player', '2026-11-04', 'start')).rejects.toThrow('Could not save lineup pin.')
})

it('runs the existing manual optimizer for exactly the selected date', async () => {
    apiPost.mockResolvedValue({ optimized: 1, failed: 0 })
    await optimizeLineupDate('member', 'league', 'season', '2026-11-04')
    expect(apiPost).toHaveBeenCalledExactlyOnceWith('/league/lineup/auto-set-season', {
        memberId: 'member', leagueId: 'league', leagueSeasonId: 'season', dates: ['2026-11-04'],
    })
})

it.each([{ failed: 1 }, { results: [{ status: 'failed' }] }])('rejects partial optimizer failures: %j', async result => {
    apiPost.mockResolvedValue(result)
    await expect(optimizeLineupDate('member', 'league', 'season', '2026-11-04')).rejects.toThrow('Could not update the lineup')
})

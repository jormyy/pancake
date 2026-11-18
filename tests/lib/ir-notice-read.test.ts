import { afterEach, expect, it, vi } from 'vitest'
import { parseAutoIrNotices, readAutoIrNotices } from '@/lib/lineup/ir-notice-read'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

afterEach(() => { vi.resetAllMocks() })

const notice = {
    playerId: 'player', playerName: 'Injured Star', reason: 'ir_choice_uncertain', action: 'Choose who moves to IR',
}

it('reads the notices for the league season through the narrow RPC boundary', async () => {
    rpc.mockResolvedValue({ data: { enabled: true, notices: [notice] }, error: null })
    await expect(readAutoIrNotices('league', 'season')).resolves.toEqual({ enabled: true, notices: [notice] })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_auto_ir_notices', {
        p_league_id: 'league', p_league_season_id: 'season',
    })
})

it('preserves the read error', async () => {
    const error = { message: 'not a member' }
    rpc.mockResolvedValue({ data: null, error })
    await expect(readAutoIrNotices('league', 'season')).rejects.toBe(error)
})

it('drops notices when Auto Lineup is disabled', () => {
    expect(parseAutoIrNotices({ enabled: false, notices: [notice] })).toEqual({ enabled: false, notices: [] })
})

it('drops malformed notices and tolerates a missing payload', () => {
    expect(parseAutoIrNotices({ enabled: true, notices: [notice, { playerId: 'x' }, null] }))
        .toEqual({ enabled: true, notices: [notice] })
    expect(parseAutoIrNotices(null)).toEqual({ enabled: false, notices: [] })
})

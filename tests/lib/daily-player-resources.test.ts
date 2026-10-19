import { beforeEach, expect, it, vi } from 'vitest'
import { getRosterStatsMaps } from '@/lib/roster-stats'
import { getPlayerProjection } from '@/lib/projections'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import { setSessionOwner } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({ day: '2026-10-18', read: vi.fn(), projection: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => state.day }))
vi.mock('@/lib/supabase', () => ({ supabase: {
    from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ in: (ids: string[]) => state.read(table, ids) }), in: (ids: string[]) => state.read(table, ids) }) }) }),
    rpc: state.projection,
} }))
beforeEach(() => {
    vi.clearAllMocks()
    setSessionOwner('first')
    state.day = '2026-10-18'
    setLeagueChangesConnected('league', true)
    notifyLeagueChange('league', { topic: 'catchup', scopes: null })
    state.read.mockResolvedValue({ data: [], error: null })
    state.projection.mockResolvedValue({ data: [{ player_id: 'player', projection_fantasy_points: 21 }], error: null })
})

it('joins matching averages and projections and ignores live-stat changes until daily sources change', async () => {
    await Promise.all([getRosterStatsMaps(['player'], 'league'), getRosterStatsMaps(['player'], 'league')])
    await getPlayerProjection('player', 'league')
    notifyLeagueChange('league', { topic: 'stat', scopes: null })
    await getRosterStatsMaps(['player'], 'league')
    await getPlayerProjection('player', 'league')
    expect(state.read).toHaveBeenCalledTimes(2)
    expect(state.projection).toHaveBeenCalledTimes(1)
    notifyLeagueChange('league', { topic: 'resources', scopes: null, details: null })
    await getRosterStatsMaps(['player'], 'league')
    await getPlayerProjection('player', 'league')
    expect(state.read).toHaveBeenCalledTimes(4)
    expect(state.projection).toHaveBeenCalledTimes(2)
})

it('separates league, player, season, ET day and account, and never treats an unavailable baseline as fresh', async () => {
    await getPlayerProjection('player', 'league')
    await getPlayerProjection('other-player', 'league')
    await getPlayerProjection('player', 'league', 2025)
    state.day = '2026-10-19'
    await getPlayerProjection('player', 'league')
    setSessionOwner('second')
    await getPlayerProjection('player', 'league')
    setLeagueChangesConnected('league', false)
    await getPlayerProjection('player', 'league')
    await getPlayerProjection('player', 'league')
    await getPlayerProjection('player', 'other-league')
    expect(state.projection).toHaveBeenCalledTimes(8)
})

it('does not cache a failed read or a result whose source changes while it is held', async () => {
    let release!: (result: { data: { player_id: string }[]; error: null }) => void
    state.projection.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const old = getPlayerProjection('player', 'league')
    notifyLeagueChange('league', { topic: 'resources', scopes: null })
    release({ data: [{ player_id: 'old' }], error: null })
    await old
    state.projection.mockRejectedValueOnce(new Error('source unavailable'))
    await expect(getPlayerProjection('player', 'league')).rejects.toThrow('source unavailable')
    await getPlayerProjection('player', 'league')
    expect(state.projection).toHaveBeenCalledTimes(3)
})

it('expires successful resources at the maximum age', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
        await getPlayerProjection('player', 'league')
        clock.mockReturnValue(now + 299_999)
        await getPlayerProjection('player', 'league')
        expect(state.projection).toHaveBeenCalledTimes(1)
        clock.mockReturnValue(now + 300_000)
        await getPlayerProjection('player', 'league')
        expect(state.projection).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
})

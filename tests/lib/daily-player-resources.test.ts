import { beforeEach, expect, it, vi } from 'vitest'
import { getRosterStatsMaps } from '@/lib/roster-stats'
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

it('shares roster averages and ignores live-stat changes until daily sources change', async () => {
    await Promise.all([getRosterStatsMaps(['player'], 'league'), getRosterStatsMaps(['player'], 'league')])
    notifyLeagueChange('league', { topic: 'stat', scopes: null })
    await getRosterStatsMaps(['player'], 'league')
    expect(state.read).toHaveBeenCalledTimes(2)
    notifyLeagueChange('league', { topic: 'resources', scopes: null, details: null })
    await getRosterStatsMaps(['player'], 'league')
    expect(state.read).toHaveBeenCalledTimes(4)
})

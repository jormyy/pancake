import { expect, it, vi } from 'vitest'
import { tabSnapshotScope } from '@/lib/tab-snapshot'
import { fetchUserLeagues, isTradingClosed } from '@/lib/league'

vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
const boundary = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ is: async () => ({ data: structuredClone(boundary.rows), error: null }) }) }) }) } }))

it('keeps tab snapshot scopes unchanged when mock rooms and live auction pauses change', async () => {
    const draft = { draft_type: 'auction', is_mock: false, status: 'pending', league_seasons: { is_current: true } }
    const membership = { id: 'member', role: 'member', team_name: 'Team', leagues: { id: 'league', status: 'drafting', drafts: [draft] } }
    boundary.rows = [membership]
    const before = await fetchUserLeagues('user')
    membership.leagues.drafts.push({ ...draft, is_mock: true })
    membership.leagues.drafts[0] = { ...draft, status: 'paused' }
    const scopeBefore = tabSnapshotScope('user', 'member', 'league', before[0].leagues)
    const after = await fetchUserLeagues('user')
    expect(after).toEqual(before)
    expect(tabSnapshotScope('user', 'member', 'league', after[0].leagues)).toBe(scopeBefore)
    expect(isTradingClosed(after[0].leagues)).toBe(true)
    membership.leagues.drafts[0] = { ...draft, status: 'completed' }
    expect(isTradingClosed((await fetchUserLeagues('user'))[0].leagues)).toBe(false)
})

import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { useMultiTeamTradeComposer } from '@/hooks/use-multi-team-trade-composer'
vi.mock('@/components/league/draft-room/useDraftActivity', () => { const gate = { epoch: 0, canRead: () => true, capture: () => 0, isCurrent: () => true }; return { useDraftActivity: () => gate } })

const { getPicksForMembers, getRostersForMembers, getRosterStatsMaps } = vi.hoisted(() => ({
    getPicksForMembers: vi.fn(),
    getRostersForMembers: vi.fn(),
    getRosterStatsMaps: vi.fn(),
}))

const rosterPlayer = (id: string) => ({
    id: `roster-${id}`,
    member_id: 'member',
    is_on_ir: false,
    is_on_taxi: false,
    acquired_via: 'draft',
    players: {
        id,
        display_name: id,
        nba_team: null,
        position: 'PG' as const,
        eligible_positions: ['PG'],
        injury_status: null,
        nba_id: null,
        nba_draft_number: null,
        years_exp: 1,
    },
})

vi.mock('@/lib/supabase', () => ({
    supabase: { from: () => {
        const query = { select: () => query, eq: () => query, in: () => query, order: () => query,
            then: (resolve: (result: unknown) => unknown) => Promise.resolve(resolve({ data: null, error: new Error('rankings read timed out') })) }
        return query
    } },
}))
vi.mock('@/lib/trades', () => ({ getPicksForMembers }))
vi.mock('@/lib/roster', () => ({ getRostersForMembers }))
vi.mock('@/lib/roster-stats', () => ({
    EMPTY_AVG_MAP: new Map(),
    EMPTY_STATS_MAP: new Map(),
    getRosterStatsMaps,
}))
vi.mock('@/lib/alert', () => ({ getErrorMessage: (error: unknown) => String(error) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    vi.clearAllMocks()
    getRostersForMembers.mockImplementation(async (memberIds: string[]) =>
        Object.fromEntries(memberIds.map((memberId) => [memberId, []])))
    getPicksForMembers.mockImplementation(async (memberIds: string[]) =>
        Object.fromEntries(memberIds.map((memberId) => [memberId, []])))
    getRosterStatsMaps.mockResolvedValue({ avgMap: new Map(), avgStatsMap: new Map() })
})

it('keeps canonical roster assets available if ranking enrichment fails', async () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {})
    getRostersForMembers.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, [rosterPlayer(`player-${id}`)]])))
    let latest!: ReturnType<typeof useMultiTeamTradeComposer>
    const Probe = () => {
        latest = useMultiTeamTradeComposer({ enabled: true, leagueId: 'league', myMemberId: 'me', myTeamName: 'Me',
            members: [{ id: 'other', team_name: 'Other' }], faabEnabled: false, recipientMemberId: 'other' })
        const setParticipants = latest.setParticipantIds
        React.useEffect(() => setParticipants(['me', 'other']), [setParticipants])
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => renderer.unmount())
    silence.mockRestore()
    expect(latest.rosterError).toBe(null)
    expect(latest.assetsReady).toBe(true)
    expect(latest.displayReady).toBe(true)
    expect(latest.participantRosters.me).toEqual([expect.objectContaining({ players: expect.objectContaining({ id: 'player-me' }), tradeValue: null })])
    expect(latest.participantRosters.other).toHaveLength(1)
})

import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useMultiTeamTradeComposer } from '@/hooks/use-multi-team-trade-composer'

const { getPicksForMembers, getRostersForMembers, getRosterStatsMaps } = vi.hoisted(() => ({
    getPicksForMembers: vi.fn(),
    getRostersForMembers: vi.fn(),
    getRosterStatsMaps: vi.fn(),
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

describe('useMultiTeamTradeComposer', () => {
    it('resets participants, assets, routes, and FAAB when league/member identity changes', async () => {
        let latest!: ReturnType<typeof useMultiTeamTradeComposer>
        const Probe = ({ leagueId, memberId }: { leagueId: string; memberId: string }) => {
            latest = useMultiTeamTradeComposer({
                enabled: false,
                leagueId,
                myMemberId: memberId,
                myTeamName: memberId,
                members: [],
                faabEnabled: true,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a', memberId: 'member-a' })) })
        await act(async () => {
            latest.setParticipantIds(['member-a', 'member-other'])
            latest.selectParticipantAsset('member-a', 'player', 'player-a')
            latest.setParticipantFaab('member-a', '25')
        })
        expect(latest.participantIds).toEqual(['member-a', 'member-other'])
        expect(latest.buildMultiTeamItems()).toHaveLength(2)
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b', memberId: 'member-b' })) })
        expect(latest.participantIds).toEqual(['member-b'])
        expect(latest.selectedParticipantIds.size).toBe(0)
        expect(latest.buildMultiTeamItems()).toEqual([])
        await act(async () => { renderer.unmount() })
    })
})

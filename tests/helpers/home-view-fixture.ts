import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'
import type { HomeView } from '@/lib/cache/view-types'
import type { Matchup } from '@/lib/scoring'
import { todayET } from '@/lib/shared/dates'
import { resolveHomeSurface } from '@/lib/home-surface'

export const lineup = (id = 'player', benchSlots = 1) => ({ starters: [{ slotType: 'PG', player: null }], bench: id ? [{ playerId: id, rosterPlayerId: `roster-${id}`, displayName: id, position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'BOS', injuryStatus: null, nbaId: null }] : [], benchSlots, ir: [], taxi: [] })
export function homePayload(date = todayET(), points = 4): HomeView {
    return { context: { leagueId: 'league', memberId: 'member', seasonId: 'season', seasonYear: 2026, weekNumber: 1, today: todayET(), version: '1', stale: false }, selectedDate: date, matchup: { id: 'matchup', seasonId: 'season', seasonYear: 2026, weekNumber: 1, myMemberId: 'member', opponentMemberId: 'opponent', myPoints: points, opponentPoints: 3 } as Matchup, myLineup: lineup(date), oppLineup: lineup('opponent'), weekDays: [{ date, dayLabel: 'Today', dateNum: 27, hasGames: false, isToday: true, playingTeams: [] }], leagueMatchups: [] }
}
export function homeHarness(observe?: (value: ReturnType<typeof useMatchupData>) => void) {
    let latest!: ReturnType<typeof useMatchupData>
    let screen: ReactTestRenderer | undefined
    const frames: ReturnType<typeof useMatchupData>[] = []
    type Props = { member?: string | null; league?: string; owner?: string; validated?: boolean; error?: Error | null; retry?: () => Promise<void> }
    const Probe = ({ member = 'member', league = 'league', owner = 'account', validated = true, error = null, retry }: Props) => {
        latest = useMatchupData(member ? { id: member } : null, { id: owner }, { id: league }, validated, error, retry)
        observe?.(latest)
        frames.push(latest)
        return null
    }
    const render = async (props: Props = {}) => { await act(async () => { if (screen) screen.update(React.createElement(Probe, props)); else screen = create(React.createElement(Probe, props)) }); await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
    const unmount = async () => { await act(async () => screen?.unmount()); screen = undefined }
    afterEach(unmount)
    return { get latest() { return latest }, frames, render, unmount, surface: () => resolveHomeSurface({ leagueStatus: 'active', hasMatchup: Boolean(latest.matchup), loading: latest.matchupLoading, error: latest.error, emptyConfirmed: latest.emptyConfirmed }) }
}

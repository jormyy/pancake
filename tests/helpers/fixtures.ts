import type { PlayerHeaderPlayer } from '@/components/player/PlayerHeader'
import type { MemberTransactionState } from '@/lib/league'
import type { PlayerRow } from '@/lib/players'
import type { PlayerRosterStatus, RosterPlayer } from '@/lib/roster'
import type { Trade } from '@/lib/trades'

export function playerRow(overrides: Partial<PlayerRow> = {}): PlayerRow {
    return {
        id: 'player-a',
        display_name: 'Player A',
        nba_team: 'LAL',
        position: 'PG',
        eligible_positions: ['PG'],
        status: null,
        injury_status: null,
        headshot_url: null,
        nba_id: null,
        years_exp: 2,
        ...overrides,
    }
}

export function headerPlayer(overrides: Partial<PlayerHeaderPlayer> = {}): PlayerHeaderPlayer {
    return {
        display_name: 'Player A',
        nba_team: 'LAL',
        position: 'PG',
        eligible_positions: ['PG'],
        jersey_number: '1',
        injury_status: null,
        dynasty_rank: null,
        headshot_url: null,
        nba_id: null,
        years_exp: 2,
        ...overrides,
    }
}

export function rosterPlayer(overrides: Partial<RosterPlayer> = {}): RosterPlayer {
    return {
        id: 'roster-a',
        is_on_ir: false,
        is_on_taxi: false,
        acquired_via: 'draft',
        players: {
            id: 'player-a',
            display_name: 'Player A',
            nba_team: 'LAL',
            position: 'PG',
            eligible_positions: ['PG'],
            injury_status: null,
            nba_id: null,
            nba_draft_number: null,
            years_exp: 2,
        },
        ...overrides,
    }
}

export const rosterStatus = {
    onWaivers: (): PlayerRosterStatus => ({ status: 'on_waivers', logId: 'log-1', clearsAt: '2099-01-01T00:00:00.000Z' }),
    freeAgent: (): PlayerRosterStatus => ({ status: 'free_agent' }),
}

export function memberTransactionState(overrides: Partial<MemberTransactionState> = {}): MemberTransactionState {
    return {
        leagueSeasonId: 'season',
        weekNumber: 4,
        weeklyAddLimit: 7,
        weeklyAddCount: 2,
        waiverMode: 'faab',
        faabStartingBudget: 100,
        faabBalance: 40,
        addLimitResetsAt: null,
        addLimitMessage: null,
        addLimitResetsLabel: null,
        ...overrides,
    }
}

export function trade(overrides: Partial<Trade> = {}): Trade {
    return {
        id: 'trade-1',
        status: 'completed',
        proposedAt: '2026-08-27T00:00:00.000Z',
        acceptedAt: null,
        vetoWindowExpiresAt: null,
        completedAt: '2026-08-28T00:00:00.000Z',
        vetoedAt: null,
        expiresAt: null,
        notes: null,
        proposerMemberId: 'member-a',
        proposerTeamName: 'Team A',
        recipientMemberId: 'member-b',
        recipientTeamName: 'Team B',
        isMultiTeam: false,
        participants: [],
        parentTradeId: null,
        counteredFromTradeId: null,
        editedFromTradeId: null,
        replacedByTradeId: null,
        version: 1,
        proposerFaabAmount: 0,
        recipientFaabAmount: 0,
        myVetoed: false,
        routedItems: [],
        ...overrides,
    }
}

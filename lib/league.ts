import { supabase } from '@/lib/supabase'
import type { Json, League, LeagueStatus } from '@/types/database'
import type { LeagueInfo, LeagueMembership } from '@/types/app'
import { todayET } from '@/lib/shared/dates'

export type WaiverMode = 'rolling' | 'faab'

export type LeagueSettingsUpdate = {
    scoring_settings?: Record<string, number>
    roster_size?: number
    ir_slots?: number
    taxi_slots?: number
    auction_budget?: number
    playoff_start_week?: number
    weekly_add_limit?: number | null
    weekly_add_unlimited?: boolean
    waiver_mode?: WaiverMode
    faab_starting_budget?: number
}

type LineupSlotUpdate = {
    slot_type: string
    slot_count: number
}

type JsonObject = { [key: string]: Json | undefined }
type JoinedLeague = { id: string; name: string; status: string }
type LeagueMembershipQueryRow = Omit<LeagueMembership, 'leagues'> & { leagues: LeagueInfo }

function numericRecordPayload(values: Record<string, number>): JsonObject {
    const payload: JsonObject = {}
    for (const [key, value] of Object.entries(values)) {
        payload[key] = value
    }
    return payload
}

function leagueSettingsPayload(updates: LeagueSettingsUpdate): Json {
    const payload: JsonObject = {}
    if (updates.scoring_settings != null) payload.scoring_settings = numericRecordPayload(updates.scoring_settings)
    if (updates.roster_size != null) payload.roster_size = updates.roster_size
    if (updates.ir_slots != null) payload.ir_slots = updates.ir_slots
    if (updates.taxi_slots != null) payload.taxi_slots = updates.taxi_slots
    if (updates.auction_budget != null) payload.auction_budget = updates.auction_budget
    if (updates.playoff_start_week != null) payload.playoff_start_week = updates.playoff_start_week
    if (updates.weekly_add_unlimited != null) payload.weekly_add_unlimited = updates.weekly_add_unlimited
    if (updates.weekly_add_limit != null) payload.weekly_add_limit = updates.weekly_add_limit
    if (updates.waiver_mode != null) payload.waiver_mode = updates.waiver_mode
    if (updates.faab_starting_budget != null) payload.faab_starting_budget = updates.faab_starting_budget
    return payload
}

function lineupSlotsPayload(slots: LineupSlotUpdate[]): Json {
    return slots.map((slot): JsonObject => ({
        slot_type: slot.slot_type,
        slot_count: slot.slot_count,
    }))
}

function jsonRecord(value: Json | null, label: string): JsonObject {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} returned an unexpected payload`)
    }
    return value
}

function jsonString(value: Json | undefined, field: string): string {
    if (typeof value !== 'string') throw new Error(`Missing ${field}`)
    return value
}

function joinedLeagueFromJson(value: Json | null): JoinedLeague {
    const row = jsonRecord(value, 'join league')
    return {
        id: jsonString(row.id, 'league id'),
        name: jsonString(row.name, 'league name'),
        status: jsonString(row.status, 'league status'),
    }
}

export async function createLeague(
    _userId: string,
    name: string,
    teamName: string,
    auctionBudget: number = 200,
) {
    const { data: league, error } = await supabase.rpc('create_league', {
        p_name: name,
        p_team_name: teamName,
        p_auction_budget: auctionBudget,
    })

    if (error) throw error
    return jsonRecord(league, 'create league') as League
}

export async function joinLeague(inviteCode: string, _userId: string, teamName: string) {
    const { data, error } = await supabase.rpc('join_league_by_invite_code', {
        p_invite_code: inviteCode,
        p_team_name: teamName,
    })

    if (error) throw new Error(error.message)
    return joinedLeagueFromJson(data)
}

export async function fetchUserLeagues(userId: string) {
    const { data, error } = await supabase
        .from('league_members')
        .select(
            `
      id,
      role,
      team_name,
      leagues!league_members_league_id_fkey!inner (
        id,
        name,
        invite_code,
        status,
        commissioner_id,
        auction_budget,
        scoring_settings,
        playoff_start_week,
        roster_size,
        ir_slots,
        taxi_slots,
        trade_deadline,
        deleted_at,
        deleted_by,
        weekly_add_limit,
        waiver_mode,
        faab_starting_budget
      )
    `,
        )
        .eq('user_id', userId)
        .is('leagues.deleted_at', null)

    if (error) throw error
    return (data ?? []) as LeagueMembershipQueryRow[]
}

/**
 * Dynasty trade window (mirrors propose_trade_atomic): trading is available
 * during active and playoff seasons, and closes after a configured deadline.
 * A null deadline never locks an otherwise tradable league.
 */
export function isTradingClosed(
    league: { status: LeagueStatus; trade_deadline?: string | null } | null | undefined,
): boolean {
    if (!league) return false
    if (league.status !== 'active' && league.status !== 'playoffs') return true
    if (!league.trade_deadline) return false
    return league.trade_deadline < todayET()
}

export async function getLeagueMembers(leagueId: string) {
    const { data, error } = await supabase
        .from('league_members')
        .select('id, role, team_name, user_id, profiles ( display_name, username )')
        .eq('league_id', leagueId)
        .order('joined_at')

    if (error) throw error
    return data ?? []
}

export async function updateTeamName(memberId: string, teamName: string) {
    const { error } = await supabase
        .from('league_members')
        .update({ team_name: teamName })
        .eq('id', memberId)
    if (error) throw error
}

export async function getLineupSlots(leagueId: string) {
    const { data, error } = await supabase
        .from('lineup_slot_templates')
        .select('slot_type, slot_count')
        .eq('league_id', leagueId)

    if (error) throw error
    return data ?? []
}

export async function updateLeague(
    leagueId: string,
    updates: LeagueSettingsUpdate,
) {
    // The RPC enforces commissioner authority and setup-only structural edits.
    const { error } = await supabase.rpc('update_league_settings_atomic', {
        p_league_id: leagueId,
        p_settings: leagueSettingsPayload(updates),
    })
    if (error) throw error
}

export async function updateLineupSlots(
    leagueId: string,
    slots: LineupSlotUpdate[],
) {
    // The RPC locks the league and keeps lineup templates setup-only.
    const { error } = await supabase.rpc('update_lineup_slots_atomic', {
        p_league_id: leagueId,
        p_slots: lineupSlotsPayload(slots),
    })
    if (error) throw error
}

export async function deleteLeague(leagueId: string) {
    const { data, error } = await supabase.rpc('delete_league_atomic', {
        p_league_id: leagueId,
    })
    if (error) throw error
    return data as {
        deleted: boolean
        alreadyDeleted: boolean
        leagueId: string
        deletedAt: string
        cancelledDrafts?: number
        closedNominations?: number
    }
}

export type MemberTransactionState = {
    leagueSeasonId: string
    weekNumber: number
    weeklyAddLimit: number | null
    weeklyAddCount: number
    waiverMode: WaiverMode
    faabStartingBudget: number
    faabBalance: number
}

type MemberTransactionStateRow = {
    league_season_id: string
    week_number: number
    weekly_add_limit: number | null
    weekly_add_count: number
    waiver_mode: WaiverMode
    faab_starting_budget: number
    faab_balance: number
}

export async function getMemberTransactionState(
    memberId: string,
    leagueId: string,
): Promise<MemberTransactionState | null> {
    const { data, error } = await supabase.rpc('get_member_transaction_state', {
        p_member_id: memberId,
        p_league_id: leagueId,
    })
    if (error) throw error
    const row = data?.[0] as MemberTransactionStateRow | undefined
    if (!row) return null
    return {
        leagueSeasonId: row.league_season_id,
        weekNumber: row.week_number,
        weeklyAddLimit: row.weekly_add_limit,
        weeklyAddCount: row.weekly_add_count,
        waiverMode: row.waiver_mode,
        faabStartingBudget: row.faab_starting_budget,
        faabBalance: row.faab_balance,
    }
}

export async function adjustFaabBalance(
    leagueId: string,
    memberId: string,
    balance: number,
): Promise<number> {
    const { data, error } = await supabase.rpc('commissioner_adjust_faab_balance_atomic', {
        p_league_id: leagueId,
        p_member_id: memberId,
        p_balance: balance,
    })
    if (error) throw error
    return Number(data)
}

export async function overrideWeeklyAddCount(
    leagueId: string,
    memberId: string,
    addCount: number,
): Promise<number> {
    const { data, error } = await supabase.rpc('commissioner_override_weekly_add_count_atomic', {
        p_league_id: leagueId,
        p_member_id: memberId,
        p_add_count: addCount,
    })
    if (error) throw error
    return Number(data)
}

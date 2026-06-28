import { supabase } from '@/lib/supabase'
import type { Json, League } from '@/types/database'

type LeagueSettingsUpdate = {
    scoring_settings?: Record<string, number>
    roster_size?: number
    ir_slots?: number
    taxi_slots?: number
    auction_budget?: number
    playoff_start_week?: number
}

type LineupSlotUpdate = {
    slot_type: string
    slot_count: number
}

type JsonObject = { [key: string]: Json | undefined }

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
    return payload
}

function lineupSlotsPayload(slots: LineupSlotUpdate[]): Json {
    return slots.map((slot): JsonObject => ({
        slot_type: slot.slot_type,
        slot_count: slot.slot_count,
    }))
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
    return league as unknown as League
}

export async function joinLeague(inviteCode: string, _userId: string, teamName: string) {
    const { data, error } = await (supabase as any).rpc('join_league_by_invite_code', {
        p_invite_code: inviteCode,
        p_team_name: teamName,
    })

    if (error) throw new Error(error.message)
    return data as { id: string; name: string; status: string }
}

export async function fetchUserLeagues(userId: string) {
    const { data, error } = await supabase
        .from('league_members')
        .select(
            `
      id,
      role,
      team_name,
      leagues (
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
        taxi_slots
      )
    `,
        )
        .eq('user_id', userId)

    if (error) throw error
    return data ?? []
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

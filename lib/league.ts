import { supabase } from '@/lib/supabase'
import type { Json, League } from '@/types/database'

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
    updates: {
        scoring_settings?: Record<string, number>
        roster_size?: number
        ir_slots?: number
        taxi_slots?: number
        auction_budget?: number
        playoff_start_week?: number
    },
) {
    // Route through the SECURITY DEFINER RPC introduced in
    // 20260516360000_update_league_settings_atomic.sql. The RPC gates the
    // four "structural" keys (scoring_settings, roster_size, ir_slots,
    // taxi_slots) plus auction_budget on leagues.status = 'setup' so a
    // commissioner cannot rewrite scoring weights or roster caps after the
    // draft has shipped. playoff_start_week (and trade_deadline, supported
    // by the RPC even though this signature does not surface it) remain
    // tunable mid-season.
    //
    // The direct PostgREST UPDATE path that previously lived here was the
    // only legitimate caller for the column-level UPDATE grants in
    // 20260516300000_leagues_column_grants.sql; the grants are retained for
    // playoff_start_week / trade_deadline mid-season writes that still need
    // an authenticated path (the RPC is itself the only authenticated path
    // now, so the column grant is defense-in-depth).
    // The supabase-js client serializes the rpc argument as JSON. The
    // generated `Json` type for `p_settings` is a recursive union that does
    // not structurally accept arbitrary `Record<string, number | object>`
    // shapes, so we cast through `unknown` to satisfy the typechecker. The
    // RPC validates each key's jsonb type server-side.
    const { error } = await supabase.rpc('update_league_settings_atomic', {
        p_league_id: leagueId,
        p_settings: updates as unknown as Json,
    })
    if (error) throw error
}

export async function updateLineupSlots(
    leagueId: string,
    slots: { slot_type: string; slot_count: number }[],
) {
    // Route through the SECURITY DEFINER RPC introduced in
    // 20260516410000_atomic_lineup_slot_templates.sql. The RPC takes a
    // leagues FOR UPDATE lock, verifies commissioner role, and gates the
    // upsert on leagues.status = 'setup'. Without this gate a commissioner
    // could rewrite the league's starting-lineup layout (e.g. PF: 2 → 1)
    // mid-season, silently changing which players are starters going
    // forward — a parallel structural-change path that bypassed the iter
    // 36 update_league_settings_atomic gate.
    //
    // The direct PostgREST upsert that previously lived here was the only
    // legitimate authenticated caller for the slot_templates_insert /
    // slot_templates_update RLS policies; this slice also REVOKEs the
    // underlying authenticated INSERT/UPDATE/DELETE table grants so the
    // RPC is now the only authenticated write path. service_role bypasses
    // RLS for backend lifecycle scripts.
    //
    // The supabase-js client serializes the rpc argument as JSON. The
    // generated `Json` type for `p_slots` is a recursive union that does
    // not structurally accept arbitrary `{ slot_type, slot_count }[]`
    // shapes, so we cast through `unknown` to satisfy the typechecker.
    // The RPC validates each entry's jsonb shape server-side and casts
    // slot_type to the roster_slot_type enum.
    const { error } = await supabase.rpc('update_lineup_slots_atomic', {
        p_league_id: leagueId,
        p_slots: slots as unknown as Json,
    })
    if (error) throw error
}

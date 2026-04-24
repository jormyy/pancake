import { supabase } from '@/lib/supabase'
import type { League, RosterSlotType } from '@/types/database'
import { currentSeasonYear } from '@/lib/shared/season'

function generateInviteCode(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function generateSlug(name: string): string {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
    const suffix = Math.random().toString(36).slice(2, 6)
    return `${base}-${suffix}`
}

export async function createLeague(
    userId: string,
    name: string,
    teamName: string,
    auctionBudget: number = 200,
) {
    const slug = generateSlug(name)
    const inviteCode = generateInviteCode()

    const { data: league, error: leagueError } = await supabase
        .from('leagues')
        .insert({
            name,
            slug,
            invite_code: inviteCode,
            commissioner_id: userId,
            auction_budget: auctionBudget,
        })
        .select()
        .single<League>()

    if (leagueError) throw leagueError

    const { data: member, error: memberError } = await supabase
        .from('league_members')
        .insert({
            league_id: league.id,
            user_id: userId,
            role: 'commissioner',
            team_name: teamName,
        })
        .select('id')
        .single()

    if (memberError) throw memberError

    const { error: seasonError } = await supabase
        .from('league_seasons')
        .insert({ league_id: league.id, season_year: currentSeasonYear(), is_current: true })

    if (seasonError) throw seasonError

    const PICKS = [
        [2027, 1], [2027, 2], [2027, 3],
        [2028, 1], [2028, 2], [2028, 3],
        [2029, 1], [2029, 2], [2029, 3],
        [2030, 1], [2030, 2],
    ]
    const { error: picksError } = await supabase.from('draft_picks').insert(
        PICKS.map(([season_year, round]) => ({
            league_id: league.id,
            season_year,
            round,
            original_owner_id: member.id,
            current_owner_id: member.id,
        })),
    )
    if (picksError) throw picksError

    return league
}

export async function joinLeague(inviteCode: string, _userId: string, teamName: string) {
    const { data, error } = await supabase.rpc('join_league_by_invite_code', {
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
        ir_slots
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
    const { error } = await supabase.from('leagues').update(updates).eq('id', leagueId)
    if (error) throw error
}

export async function updateLineupSlots(
    leagueId: string,
    slots: { slot_type: string; slot_count: number }[],
) {
    const rows = slots.map((s) => ({ league_id: leagueId, slot_type: s.slot_type as RosterSlotType, slot_count: s.slot_count }))
    const { error } = await supabase
        .from('lineup_slot_templates')
        .upsert(rows, { onConflict: 'league_id,slot_type' })
    if (error) throw error
}

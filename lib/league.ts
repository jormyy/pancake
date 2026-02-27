import { supabase } from '@/lib/supabase'

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

function currentSeasonYear(): number {
    const now = new Date()
    return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear()
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
        .single()

    if (leagueError) throw leagueError

    const { error: memberError } = await supabase
        .from('league_members')
        .insert({
            league_id: league.id,
            user_id: userId,
            role: 'commissioner',
            team_name: teamName,
        })

    if (memberError) throw memberError

    const { error: seasonError } = await supabase
        .from('league_seasons')
        .insert({ league_id: league.id, season_year: currentSeasonYear(), is_current: true })

    if (seasonError) throw seasonError

    return league
}

export async function joinLeague(inviteCode: string, userId: string, teamName: string) {
    const { data: league, error: findError } = await supabase
        .from('leagues')
        .select('id, name, status')
        .eq('invite_code', inviteCode.toUpperCase().trim())
        .single()

    if (findError) throw new Error('League not found. Check your invite code.')

    const { data: existing } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', league.id)
        .eq('user_id', userId)
        .single()

    if (existing) throw new Error('You are already in this league.')

    const { error: joinError } = await supabase
        .from('league_members')
        .insert({ league_id: league.id, user_id: userId, role: 'manager', team_name: teamName })

    if (joinError) throw joinError

    return league
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
    const rows = slots.map((s) => ({ league_id: leagueId, ...s }))
    const { error } = await supabase
        .from('lineup_slot_templates')
        .upsert(rows, { onConflict: 'league_id,slot_type' })
    if (error) throw error
}

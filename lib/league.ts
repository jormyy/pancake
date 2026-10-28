import { rememberLeagueTimezone, leagueTimezone } from '@/lib/league-timezones'
import { todayLeague } from '@/lib/timezone'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { notifyLeagueChange } from '@/lib/league-changes'
import { withPwaMutation } from '@/lib/shared/pwa-mutation'
import { supabase } from '@/lib/supabase'
import type { Json, League, LeagueStatus } from '@/types/database'
import type { LeagueInfo, LeagueMembership, TradeVetoMode } from '@/types/app'

export type WaiverMode = 'rolling' | 'faab'
export type { TradeVetoMode } from '@/types/app'

export type LeagueSettingsUpdate = {
    timezone?: string
    team_limit?: number
    taxi_max_seasons?: number
    allow_inactive_trades?: boolean
    playoff_entrants?: number
    playoff_round_lengths?: number[]
    skipped_weeks?: number[]
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
    trade_veto_mode?: TradeVetoMode
    trade_veto_window_hours?: number
    trade_veto_threshold_percent?: number
    /** "MM-DD", repeated every season; null removes the deadline. */
    trade_deadline?: string | null
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
    if (updates.timezone !== undefined) payload.timezone = updates.timezone
    for (const key of ['team_limit','taxi_max_seasons','allow_inactive_trades','playoff_entrants','playoff_round_lengths','skipped_weeks'] as const) {
        if (updates[key] !== undefined) payload[key] = updates[key]
    }
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
    if (updates.trade_veto_mode != null) payload.trade_veto_mode = updates.trade_veto_mode
    if (updates.trade_veto_window_hours != null) payload.trade_veto_window_hours = updates.trade_veto_window_hours
    if (updates.trade_veto_threshold_percent != null) payload.trade_veto_threshold_percent = updates.trade_veto_threshold_percent
    if (updates.trade_deadline !== undefined) payload.trade_deadline = updates.trade_deadline
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
    return withPwaMutation('createLeague', async () => {
        const { data: league, error } = await supabase.rpc('create_league', {
            p_name: name,
            p_team_name: teamName,
            p_auction_budget: auctionBudget,
        })

        if (error) throw error
        return jsonRecord(league, 'create league') as League
    })
}

export async function joinLeague(inviteCode: string, _userId: string, teamName: string) {
    return withPwaMutation('joinLeague', async () => {
        const { data, error } = await supabase.rpc('join_league_by_invite_code', {
            p_invite_code: inviteCode,
            p_team_name: teamName,
        })

        if (error) throw new Error(error.message)
        return joinedLeagueFromJson(data)
    })
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
        timezone,
        status,
        commissioner_id,
        auction_budget,
        scoring_settings,
        playoff_start_week,
        team_limit, taxi_rule, taxi_max_seasons, allow_inactive_trades, playoff_entrants, playoff_round_lengths,
        playoff_total_weeks,
        playoff_round_weeks,
        roster_size,
        ir_slots,
        taxi_slots,
        trade_deadline,
        deleted_at,
        deleted_by,
        weekly_add_limit,
        waiver_mode,
        faab_starting_budget,
        trade_veto_mode,
        trade_veto_window_hours,
        trade_veto_threshold_percent,
        drafts!drafts_league_id_fkey (draft_type, is_mock, status, league_seasons (is_current))
      )
    `,
        )
        .eq('user_id', userId)
        .is('leagues.deleted_at', null)

    if (error) throw error
    return ((data ?? []) as (LeagueMembershipQueryRow & { leagues: LeagueInfo & {
        drafts: { draft_type: string; is_mock: boolean; status: string; league_seasons: { is_current: boolean } | null }[]
    } })[]).map(({ leagues, ...membership }) => {
        const { drafts, ...league } = leagues
        rememberLeagueTimezone(league.id, league.timezone)
        return { ...membership, leagues: { ...league, hasStartupAuction: drafts?.some(draft => draft.draft_type === 'auction' && !draft.is_mock
            && draft.league_seasons?.is_current && ['pending', 'in_progress', 'paused'].includes(draft.status)) ?? false } }
    })
}

const TRADE_OPEN_STATUSES = new Set<LeagueStatus>(['drafting', 'active', 'playoffs', 'offseason'])


export function isTradingClosed(
    league: {
        status: LeagueStatus
        id?: string
        timezone?: string
        trade_deadline?: string | null
        hasStartupAuction?: boolean
    } | null | undefined,
): boolean {
    if (!league) return false
    if (!TRADE_OPEN_STATUSES.has(league.status)) return true
    if (league.hasStartupAuction) return true
    if (league.status !== 'active' && league.status !== 'playoffs') return false
    if (!league.trade_deadline) return false
    return league.trade_deadline < todayLeague(league.timezone ?? leagueTimezone(league.id))
}

export async function getLeagueMembers(leagueId: string) {
    const fetchPage = (from: number) => supabase
        .from('league_members')
        .select('id, role, team_name, user_id, profiles ( display_name, username )')
        .eq('league_id', leagueId)
        .order('joined_at')
        .order('id')
        .range(from, from + 999)
    const first = await fetchPage(0)
    if (first.error) throw first.error
    const rows = first.data ?? []
    let pageLength = rows.length
    while (pageLength === 1000) {
        const page = await fetchPage(rows.length)
        if (page.error) throw page.error
        pageLength = page.data?.length ?? 0
        rows.push(...page.data ?? [])
    }
    return rows
}

export async function updateTeamName(memberId: string, teamName: string) {
    return withPwaMutation('updateTeamName', async () => {
        const { error } = await supabase.rpc('save_client_settings_atomic', {
            p_kind: 'team', p_settings: { memberId, teamName },
        })
        if (error) throw error
    })
}

export async function getLineupSlots(leagueId: string) {
    const { data, error } = await supabase
        .from('lineup_slot_templates')
        .select('slot_type, slot_count')
        .eq('league_id', leagueId)

    if (error) throw error
    return data ?? []
}

export async function updateLeagueConfiguration(
    leagueId: string,
    updates: LeagueSettingsUpdate,
    slots: LineupSlotUpdate[] | null,
) {
    return withPwaMutation('updateLeagueConfiguration', async () => {
        const generation = sessionGeneration()
        const { error } = await supabase.rpc('update_league_configuration_atomic', {
            p_league_id: leagueId,
            p_settings: leagueSettingsPayload(updates),
            p_slots: slots ? lineupSlotsPayload(slots) : undefined,
        })
        if (error) throw error
        if (updates.scoring_settings !== undefined && generation === sessionGeneration()) notifyLeagueChange(leagueId, { topic: 'resources', scopes: null })
    })
}

export async function deleteLeague(leagueId: string) {
    return withPwaMutation('deleteLeague', async () => {
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
    })
}

export type MemberTransactionState = {
    leagueSeasonId: string
    weekNumber: number
    weeklyAddLimit: number | null
    weeklyAddCount: number
    waiverMode: WaiverMode
    faabStartingBudget: number
    faabBalance: number
    /** When the current add week ends and the count resets; null when the league has no schedule yet. */
    addLimitResetsAt: string | null
    /** The sentence the server raises while this week's adds are used up; null otherwise. */
    addLimitMessage: string | null
    /** The weekly reset boundary; null when the league has no schedule yet. */
    addLimitResetsLabel: string | null
}

type MemberTransactionStateRow = {
    league_season_id: string
    week_number: number
    weekly_add_limit: number | null
    weekly_add_count: number
    waiver_mode: WaiverMode
    faab_starting_budget: number
    faab_balance: number
    add_limit_resets_at: string | null
    add_limit_message: string | null
    add_limit_resets_label: string | null
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
        addLimitResetsAt: row.add_limit_resets_at,
        addLimitMessage: row.add_limit_message,
        addLimitResetsLabel: row.add_limit_resets_label,
    }
}

export async function adjustFaabBalance(
    leagueId: string,
    memberId: string,
    balance: number,
): Promise<number> {
    return withPwaMutation('adjustFaabBalance', async () => {
        const { data, error } = await supabase.rpc('commissioner_adjust_faab_balance_atomic', {
            p_league_id: leagueId,
            p_member_id: memberId,
            p_balance: balance,
        })
        if (error) throw error
        return Number(data)
    })
}

export async function overrideWeeklyAddCount(
    leagueId: string,
    memberId: string,
    addCount: number,
): Promise<number> {
    return withPwaMutation('overrideWeeklyAddCount', async () => {
        const { data, error } = await supabase.rpc('commissioner_override_weekly_add_count_atomic', {
            p_league_id: leagueId,
            p_member_id: memberId,
            p_add_count: addCount,
        })
        if (error) throw error
        return Number(data)
    })
}

export async function getLeaguePlayoffCalendar(leagueId: string) {
    const { data: season, error: seasonError } = await supabase.from('league_seasons')
        .select('season_year, skipped_weeks').eq('league_id', leagueId).eq('is_current', true).maybeSingle()
    if (seasonError) throw seasonError
    if (!season) return null
    const { data: weeks, error } = await supabase.from('season_weeks')
        .select('week_number, week_start, week_end').eq('season_year', season.season_year).order('week_number')
    if (error) throw error
    return { seasonYear: season.season_year, skippedWeeks: season.skipped_weeks, ranges: weeks ?? [], weeks: (weeks ?? []).map((week) => week.week_number) }
}

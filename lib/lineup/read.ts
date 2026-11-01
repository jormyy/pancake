import { withPwaMutation } from '@/lib/shared/pwa-mutation'
import { supabase } from '@/lib/supabase'
import type { Database, RosterSlotType } from '@/types/database'
import { getCurrentSeason, invalidateSeasonCache } from '@/lib/shared/season'
import { getCurrentWeekNumber, getSeasonWeekDates, invalidateWeekNumberCache } from '@/lib/shared/week'
import { endOfLeagueDayUTC, todayLeague } from '@/lib/timezone'
import { leagueTimezone } from '@/lib/league-timezones'
import { getEligiblePositions } from '@/lib/players'
import { onSessionCachesCleared } from '@/lib/session-cache-registry'

type PlayerRow = Database['public']['Tables']['players']['Row']

export type LineupPlayer = {
    rosterPlayerId: string
    playerId: string
    displayName: string
    position: string | null
    eligiblePositions: string[]
    nbaTeam: string | null
    yearsExp?: number | null
    careerGames?: number | null
    injuryStatus: string | null
    nbaId: string | null
    espnId?: string | null
}

export type LineupSlot = {
    slotType: string
    player: LineupPlayer | null
}

export type LineupContext = {
    seasonId: string
    seasonYear: number
    weekNumber: number
    today: string // 'YYYY-MM-DD'
}

export type WeekDay = {
    date: string         // 'YYYY-MM-DD'
    dayLabel: string     // 'Mon', 'Tue', …
    dateNum: number      // day of month
    hasGames: boolean    // any NBA games scheduled
    isToday: boolean
    playingTeams: string[]
}

// Returns the set of NBA team abbreviations whose game has already started on the given date.
/** The one client reading of "this game has started" (the server's is private.lineup_game_started). */
export function gameHasStarted(game: { status: string | null; game_time: string | null; started_at: string | null }, now: string): boolean {
    return ['InProgress', 'Final'].includes(game.status ?? '')
        || (game.game_time != null && game.game_time <= now)
        || (game.started_at != null && game.started_at <= now)
}

export async function getLineupContext(
    leagueId: string,
    owner?: { memberId: string; userId: string },
): Promise<LineupContext | null> {
    if (owner) {
        const { data, error } = await supabase.from('league_members')
            .select('id').eq('id', owner.memberId).eq('league_id', leagueId).eq('user_id', owner.userId).maybeSingle()
        if (error) throw error
        if (!data) return null
        // Snapshot recovery must validate context, not reuse the short-lived lookup caches.
        invalidateSeasonCache(leagueId)
        invalidateWeekNumberCache()
    }
    const season = await getCurrentSeason(leagueId)
    if (!season) return null
    const weekNumber = await getCurrentWeekNumber(season.seasonYear, leagueTimezone(leagueId)) ?? 1
    const today = todayLeague(leagueTimezone(leagueId))
    return { seasonId: season.id, seasonYear: season.seasonYear, weekNumber, today }
}

export async function getWeekDays(weekNumber: number, seasonYear: number, timezone?: string): Promise<WeekDay[]> {
    // Fetch week boundaries first, then query games by date range.
    // Querying by week_number on nba_games is unreliable — rows can have stale/incorrect
    // week_number values if the schedule was synced out of order or re-seeded.
    const dates = await getSeasonWeekDates(seasonYear, weekNumber, timezone)

    const today = todayLeague(timezone)
    const DAY_CHARS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
    const result: WeekDay[] = []

    const dateTeams = new Map<string, string[]>()

    if (dates.length > 0) {
        const startStr = dates[0]
        const endStr = dates[dates.length - 1]

        const { data: games, error: gamesError } = await supabase
            .from('nba_games')
            .select('game_date, home_team, away_team')
            .eq('season_year', seasonYear)
            .gte('game_date', startStr)
            .lte('game_date', endStr)
        if (gamesError) throw gamesError

        for (const g of games ?? []) {
            const date = g.game_date
            if (!dateTeams.has(date)) dateTeams.set(date, [])
            const arr = dateTeams.get(date)!
            if (g.home_team) arr.push(g.home_team)
            if (g.away_team) arr.push(g.away_team)
        }

        for (const dateStr of dates) {
            const d = new Date(`${dateStr}T12:00:00Z`)
            result.push({
                date: dateStr,
                dayLabel: DAY_CHARS[d.getUTCDay()],
                dateNum: d.getUTCDate(),
                hasGames: dateTeams.has(dateStr),
                isToday: dateStr === today,
                playingTeams: dateTeams.get(dateStr) ?? [],
            })
        }
    } else {
        // Fallback: week_start unknown — fall back to week_number query
        const { data: games, error: gamesError } = await supabase
            .from('nba_games')
            .select('game_date, home_team, away_team')
            .eq('season_year', seasonYear)
            .eq('week_number', weekNumber)
        if (gamesError) throw gamesError

        for (const g of games ?? []) {
            const date = g.game_date
            if (!dateTeams.has(date)) dateTeams.set(date, [])
            const arr = dateTeams.get(date)!
            if (g.home_team) arr.push(g.home_team)
            if (g.away_team) arr.push(g.away_team)
        }
        const uniqueDates = [...new Set([...dateTeams.keys()])].sort()
        for (const dateStr of uniqueDates) {
            const d = new Date(dateStr + 'T12:00:00Z')
            result.push({
                date: dateStr,
                dayLabel: DAY_CHARS[d.getUTCDay()],
                dateNum: d.getUTCDate(),
                hasGames: true,
                isToday: dateStr === today,
                playingTeams: dateTeams.get(dateStr) ?? [],
            })
        }
    }

    return result
}

// Silent live refreshes re-read lineups every few seconds, but slot templates
// and rosters are near-static (settings edits; trades/waivers). Short-TTL
// promise caches let that path skip the redundant queries; fresh reads still
// repopulate the caches so cached refreshes stay recent.
const TEMPLATE_CACHE_TTL_MS = 5 * 60_000
const ROSTER_CACHE_TTL_MS = 60_000

async function fetchSlotTemplates(leagueId: string) {
    const { data, error } = await supabase
        .from('lineup_slot_templates')
        .select('slot_type, slot_count')
        .eq('league_id', leagueId)
    if (error) throw error
    return data ?? []
}

async function fetchRosterPlayers(memberId: string, leagueId: string, seasonId: string) {
    const { data, error } = await supabase
        .from('roster_players')
        .select('id, player_id, is_on_ir, is_on_taxi, players(display_name, position, eligible_positions, nba_team, injury_status, nba_id, years_exp, career_regular_season_games)')
        .eq('member_id', memberId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .order('player_id', { ascending: true })
    if (error) throw error
    return data ?? []
}

type CachedRead<T> = { at: number; promise: Promise<T>; settled: boolean }
const templateCache = new Map<string, CachedRead<Awaited<ReturnType<typeof fetchSlotTemplates>>>>()
const rosterCache = new Map<string, CachedRead<Awaited<ReturnType<typeof fetchRosterPlayers>>>>()
onSessionCachesCleared(() => {
    templateCache.clear()
    rosterCache.clear()
})

// A realtime lineup event can follow a roster change (add then slot) inside the
// TTL; dropping the member's cached roster keeps the next silent refresh honest.
export function invalidateCachedRoster(memberId: string, leagueId: string, seasonId: string): void {
    rosterCache.delete(`${memberId}:${leagueId}:${seasonId}`)
}

function ttlCached<T>(
    cache: Map<string, CachedRead<T>>,
    key: string,
    ttlMs: number,
    allowCached: boolean,
    fetcher: () => Promise<T>,
    sharePending = allowCached,
): Promise<T> {
    const now = Date.now()
    const hit = cache.get(key)
    // A read still in flight is as fresh as a new one, so the two lineups of a
    // full matchup load share one slot-template request.
    if (hit && ((!hit.settled && sharePending) || (hit.settled && allowCached && now - hit.at < ttlMs))) return hit.promise
    const entry: CachedRead<T> = { at: now, promise: fetcher(), settled: false }
    cache.set(key, entry)
    entry.promise.then(
        () => { entry.settled = true },
        () => {
            entry.settled = true
            if (cache.get(key) === entry) cache.delete(key)
        },
    )
    return entry.promise
}

export async function getWeeklyLineup(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    gameDate: string,
    options: { allowCachedStatics?: boolean; timezone?: string } = {},
): Promise<{ starters: LineupSlot[]; bench: LineupPlayer[]; benchSlots: number; ir: LineupPlayer[]; taxi: LineupPlayer[] }> {
    const today = todayLeague(options.timezone ?? leagueTimezone(leagueId))
    const isPastDate = gameDate < today
    const allowCached = options.allowCachedStatics ?? false

    const [templates, roster, assignmentsResult] = await Promise.all([
        ttlCached(templateCache, leagueId, TEMPLATE_CACHE_TTL_MS, allowCached,
            () => fetchSlotTemplates(leagueId), true),
        ttlCached(rosterCache, `${memberId}:${leagueId}:${seasonId}`, ROSTER_CACHE_TTL_MS, allowCached,
            () => fetchRosterPlayers(memberId, leagueId, seasonId)),
        supabase
            .from('weekly_lineups')
            .select('player_id, slot_type')
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId)
            .eq('game_date', gameDate)
            .order('player_id', { ascending: true }),
    ])
    if (assignmentsResult.error) throw assignmentsResult.error

    const assignments = assignmentsResult.data ?? []

    const assignmentMap = new Map<string, string>(
        assignments.map((a) => [a.player_id, a.slot_type]),
    )

    const reservePlayerIds = new Set(roster.filter(row => row.is_on_ir || row.is_on_taxi).map(row => row.player_id))
    const rosterByPlayerId = new Map<string, LineupPlayer>()
    for (const r of roster) {
        // Supabase types `players` as a possible array | object | null depending on relationship inference.
        // The join is one-to-one, so we normalize to a single record.
        const playersRel = r.players
        const p = Array.isArray(playersRel) ? (playersRel[0] ?? null) : playersRel
        rosterByPlayerId.set(r.player_id, {
            rosterPlayerId: r.id,
            playerId: r.player_id,
            displayName: p?.display_name ?? '',
            position: p?.position ?? null,
            eligiblePositions: getEligiblePositions(p ?? {}),
            nbaTeam: p?.nba_team ?? null,
            yearsExp: p?.years_exp ?? null,
            careerGames: p?.career_regular_season_games ?? null,
            injuryStatus: p?.injury_status ?? null,
            nbaId: p?.nba_id ?? null,
        })
    }

    // A drop preserves locked starters, including today's. Read those players
    // directly so their occupied slots remain visible.
    let addedAfterDate = new Set<string>()
    const missingPlayerIds = [...assignmentMap.keys()].filter((pid) => !rosterByPlayerId.has(pid))
    if (isPastDate || missingPlayerIds.length > 0) {
        type ExtraPlayer = Pick<PlayerRow, 'id' | 'display_name' | 'position' | 'eligible_positions' | 'nba_team' | 'injury_status' | 'nba_id' | 'years_exp' | 'career_regular_season_games'>
        const [extraPlayersResult, laterAddsResult] = await Promise.all([
            missingPlayerIds.length > 0
                ? supabase
                    .from('players')
                    .select('id, display_name, position, eligible_positions, nba_team, injury_status, nba_id, years_exp, career_regular_season_games')
                    .in('id', missingPlayerIds)
                : Promise.resolve({ data: [] as ExtraPlayer[], error: null }),
            isPastDate ? supabase
                .from('roster_transactions')
                .select('player_id')
                .eq('member_id', memberId)
                .eq('league_id', leagueId)
                .eq('league_season_id', seasonId)
                .in('transaction_type', ['fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over'])
                .gt('occurred_at', endOfLeagueDayUTC(gameDate, options.timezone ?? leagueTimezone(leagueId)))
                : Promise.resolve({ data: [] as { player_id: string }[], error: null }),
        ])
        if (extraPlayersResult.error) throw extraPlayersResult.error
        if (laterAddsResult.error) throw laterAddsResult.error

        for (const p of extraPlayersResult.data ?? []) {
            rosterByPlayerId.set(p.id, {
                rosterPlayerId: '',
                playerId: p.id,
                displayName: p.display_name ?? '',
                position: p.position ?? null,
                eligiblePositions: getEligiblePositions(p),
                nbaTeam: p.nba_team ?? null,
                yearsExp: p.years_exp ?? null,
                careerGames: p.career_regular_season_games ?? null,
                injuryStatus: p.injury_status ?? null,
                nbaId: p.nba_id ?? null,
            })
        }

        addedAfterDate = new Set((laterAddsResult.data ?? []).map((r) => r.player_id))
    }

    // Taxi slots are tracked via `roster_players.is_on_taxi`, not as a slot template type,
    // so the enum doesn't include 'TX'. Only BE/IR are excluded here.
    const starterTemplates = templates.filter(
        (t) => t.slot_type !== 'BE' && t.slot_type !== 'IR',
    )

    const slotGroups: Record<string, string[]> = {}
    for (const [playerId, slotType] of assignmentMap.entries()) {
        if (slotType !== 'BE' && slotType !== 'IR' && (gameDate <= today || !reservePlayerIds.has(playerId))) {
            if (!slotGroups[slotType]) slotGroups[slotType] = []
            slotGroups[slotType].push(playerId)
        }
    }

    const starters: LineupSlot[] = []
    for (const t of starterTemplates) {
        const assigned = slotGroups[t.slot_type] ?? []
        for (let i = 0; i < t.slot_count; i++) {
            const pid = assigned[i] ?? null
            starters.push({
                slotType: t.slot_type,
                player: pid ? (rosterByPlayerId.get(pid) ?? null) : null,
            })
        }
    }

    const starterPlayerIds = new Set(
        starters.map((s) => s.player?.playerId).filter(Boolean) as string[],
    )
    const bench: LineupPlayer[] = roster
        .filter((r) => !r.is_on_ir && !r.is_on_taxi && !starterPlayerIds.has(r.player_id) && !addedAfterDate.has(r.player_id))
        .map((r) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    const ir: LineupPlayer[] = roster
        .filter((r) => r.is_on_ir && !starterPlayerIds.has(r.player_id))
        .map((r) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    const taxi: LineupPlayer[] = roster
        .filter((r) => r.is_on_taxi && !starterPlayerIds.has(r.player_id))
        .map((r) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    return { starters, bench, benchSlots: templates.find((template) => template.slot_type === 'BE')?.slot_count ?? 0, ir, taxi }
}

export type RosterSlotPlan = {
    slots: { slotType: string; slotCount: number }[]
    assignments: Record<string, string>
}

export type LineupSlotMove = {
    playerId: string
    slotType: string
}

export async function setPlayerSlotMoves(
    {
        memberId,
        leagueId,
        seasonId,
        weekNumber,
        gameDate,
    }: {
        memberId: string
        leagueId: string
        seasonId: string
        weekNumber: number
        gameDate: string
    },
    moves: LineupSlotMove[],
): Promise<void> {
    return withPwaMutation('setPlayerSlotMoves', async () => {
        if (moves.length === 0) return
        const { error } = await supabase.rpc('set_player_slot_moves_atomic', {
            p_member_id: memberId,
            p_league_id: leagueId,
            p_league_season_id: seasonId,
            p_game_date: gameDate,
            p_week_number: weekNumber,
            p_moves: moves.map((move) => ({
                player_id: move.playerId,
                slot_type: move.slotType as RosterSlotType,
            })),
        })
        if (error) throw error
    })
}

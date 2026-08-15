import { calculateFantasyPoints, roundFantasyPoints, snakeToStatLine } from '../lib/scoring'
import { isRegularSeasonGameId } from '../lib/nba'
import { supabase } from '../lib/supabase'
import { endOfETDayUTC, fetchAllPages } from './scoreShared'

type LineupPlayer = {
    member_id: string
    player_id: string
    game_date: string
}

type LineupSlot = LineupPlayer & {
    slot_type: string
}

type PlayerEligibilitySource = {
    players?: {
        position: string | null
        eligible_positions: string[] | null
    } | {
        position: string | null
        eligible_positions: string[] | null
    }[] | null
}

type RosterPlayerForScore = PlayerEligibilitySource & {
    member_id: string
    player_id: string
    acquired_at: string | null
    is_on_ir: boolean | null
    is_on_taxi?: boolean | null
}

type RosterTransactionForScore = PlayerEligibilitySource & {
    id: string
    member_id: string
    player_id: string
    transaction_type: string
    occurred_at: string
}

type StatRow = Record<string, unknown> & {
    player_id: string
    game_date: string
    nba_games?: {
        nba_game_id: string | null
        game_time?: string | null
        started_at?: string | null
    } | null
}

type LineupSlotTemplate = {
    slot_type: string
    slot_count: number | null
}

type LineupCandidate = {
    points: number
    eligible_positions: string[]
}

type PlayerPointsForWeek = {
    pointsByPlayerDate: Map<string, number>
    rosterCutoffByPlayerDate: Map<string, string>
}

type ActualLineupPointsInput = {
    lineupRows: LineupSlot[]
    pointsByPlayerDate: Map<string, number>
}

type MaxPossiblePointsInput = PlayerPointsForWeek & {
    rosterRows: RosterPlayerForScore[]
    rosterTransactionRows: RosterTransactionForScore[]
}

const ROSTER_ADD_TRANSACTION_TYPES = ['fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over']
const ROSTER_DROP_TRANSACTION_TYPES = ['fa_drop', 'waiver_drop', 'trade_out']
const ROSTER_INACTIVE_TRANSACTION_TYPES = ['ir_designate', 'taxi_designate']
const ROSTER_ACTIVE_TRANSACTION_TYPES = ['ir_return', 'taxi_return']
const ROSTER_HISTORY_TRANSACTION_TYPES = [
    ...ROSTER_ADD_TRANSACTION_TYPES,
    ...ROSTER_DROP_TRANSACTION_TYPES,
    ...ROSTER_INACTIVE_TRANSACTION_TYPES,
    ...ROSTER_ACTIVE_TRANSACTION_TYPES,
]
const ROSTER_ADD_TRANSACTION_TYPE_SET = new Set(ROSTER_ADD_TRANSACTION_TYPES)
const ROSTER_DROP_TRANSACTION_TYPE_SET = new Set(ROSTER_DROP_TRANSACTION_TYPES)
const ROSTER_INACTIVE_TRANSACTION_TYPE_SET = new Set(ROSTER_INACTIVE_TRANSACTION_TYPES)
// Exported so Edge functions (lineup-optimizer) can share the starter-slot
// eligibility map without importing app code the Deno bundler cannot resolve.
export const SLOT_ALLOWED_POSITIONS: Record<string, string[]> = {
    PG: ['PG'],
    SG: ['SG'],
    SF: ['SF'],
    PF: ['PF'],
    C: ['C'],
    G: ['PG', 'SG', 'G'],
    F: ['SF', 'PF', 'F'],
    UTIL: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
}

function memberPlayerKey(memberId: string, playerId: string): string {
    return `${memberId}|${playerId}`
}

function rosterPlayerEligibility(row: PlayerEligibilitySource): string[] {
    const player = Array.isArray(row.players) ? row.players[0] : row.players
    const eligible = player?.eligible_positions?.filter(Boolean) ?? []
    if (eligible.length > 0) return eligible
    return player?.position ? [player.position] : []
}

function latestTransactionBefore(
    rows: RosterTransactionForScore[] | undefined,
    cutoff: string,
): RosterTransactionForScore | null {
    let latest: RosterTransactionForScore | null = null
    const cutoffTime = Date.parse(cutoff)
    for (const tx of rows ?? []) {
        if (Date.parse(tx.occurred_at) > cutoffTime) break
        latest = tx
    }
    return latest
}

function latestAvailabilityAfterOwnership(
    rows: RosterTransactionForScore[] | undefined,
    ownershipTx: RosterTransactionForScore,
    cutoff: string,
): RosterTransactionForScore | null {
    let latest: RosterTransactionForScore | null = null
    const ownershipTime = Date.parse(ownershipTx.occurred_at)
    const cutoffTime = Date.parse(cutoff)
    for (const tx of rows ?? []) {
        const txTime = Date.parse(tx.occurred_at)
        if (txTime > cutoffTime) break
        if (txTime < ownershipTime) continue
        if (txTime === ownershipTime && tx.id.localeCompare(ownershipTx.id) < 0) continue
        latest = tx
    }
    return latest
}

function latestAvailabilityAfterTime(
    rows: RosterTransactionForScore[] | undefined,
    start: string | null,
    cutoff: string,
): RosterTransactionForScore | null {
    let latest: RosterTransactionForScore | null = null
    const startTime = start ? Date.parse(start) : Number.NEGATIVE_INFINITY
    const cutoffTime = Date.parse(cutoff)
    for (const tx of rows ?? []) {
        const txTime = Date.parse(tx.occurred_at)
        if (txTime > cutoffTime) break
        if (txTime < startTime) continue
        latest = tx
    }
    return latest
}

function statRosterCutoff(stat: StatRow): string {
    for (const value of [stat.nba_games?.game_time, stat.nba_games?.started_at]) {
        if (!value) continue
        const parsed = new Date(value)
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    }
    return endOfETDayUTC(stat.game_date)
}

function buildRosterEligibilityAtCutoff(
    rosterRows: RosterPlayerForScore[],
    rosterTransactionRows: RosterTransactionForScore[],
): (memberId: string, playerId: string, cutoff: string) => string[] {
    const currentRosterByMemberPlayer = new Map<string, RosterPlayerForScore>()
    for (const row of rosterRows) {
        currentRosterByMemberPlayer.set(memberPlayerKey(row.member_id, row.player_id), row)
    }

    const ownershipTransactionsByMemberPlayer = new Map<string, RosterTransactionForScore[]>()
    const availabilityTransactionsByMemberPlayer = new Map<string, RosterTransactionForScore[]>()
    for (const tx of rosterTransactionRows) {
        const key = memberPlayerKey(tx.member_id, tx.player_id)
        const target = ROSTER_ADD_TRANSACTION_TYPE_SET.has(tx.transaction_type) || ROSTER_DROP_TRANSACTION_TYPE_SET.has(tx.transaction_type)
            ? ownershipTransactionsByMemberPlayer
            : availabilityTransactionsByMemberPlayer
        const rows = target.get(key) ?? []
        rows.push(tx)
        target.set(key, rows)
    }
    for (const rows of [...ownershipTransactionsByMemberPlayer.values(), ...availabilityTransactionsByMemberPlayer.values()]) {
        rows.sort((a, b) => {
            const byTime = Date.parse(a.occurred_at) - Date.parse(b.occurred_at)
            return byTime === 0 ? a.id.localeCompare(b.id) : byTime
        })
    }

    return (memberId: string, playerId: string, cutoff: string) => {
        const key = memberPlayerKey(memberId, playerId)
        const latestOwnershipTransaction = latestTransactionBefore(ownershipTransactionsByMemberPlayer.get(key), cutoff)
        if (latestOwnershipTransaction) {
            if (!ROSTER_ADD_TRANSACTION_TYPE_SET.has(latestOwnershipTransaction.transaction_type)) return []
            const latestAvailabilityTransaction = latestAvailabilityAfterOwnership(
                availabilityTransactionsByMemberPlayer.get(key),
                latestOwnershipTransaction,
                cutoff,
            )
            if (latestAvailabilityTransaction && ROSTER_INACTIVE_TRANSACTION_TYPE_SET.has(latestAvailabilityTransaction.transaction_type)) return []
            return rosterPlayerEligibility(latestOwnershipTransaction)
        }

        const currentRoster = currentRosterByMemberPlayer.get(key)
        if (!currentRoster) return []
        if (currentRoster.is_on_ir || currentRoster.is_on_taxi) return []
        if (currentRoster.acquired_at && Date.parse(currentRoster.acquired_at) > Date.parse(cutoff)) return []
        const latestAvailabilityTransaction = latestAvailabilityAfterTime(
            availabilityTransactionsByMemberPlayer.get(key),
            currentRoster.acquired_at,
            cutoff,
        )
        if (latestAvailabilityTransaction && ROSTER_INACTIVE_TRANSACTION_TYPE_SET.has(latestAvailabilityTransaction.transaction_type)) return []
        return rosterPlayerEligibility(currentRoster)
    }
}

function canPlayStarterSlot(eligiblePositions: string[], slotType: string): boolean {
    const allowed = SLOT_ALLOWED_POSITIONS[slotType]
    if (!allowed || eligiblePositions.length === 0) return false
    return eligiblePositions.some((position) => allowed.includes(position))
}

function sortSlotsByFlexibility(slots: string[]): string[] {
    return [...slots].sort((a, b) => {
        const byFlex = (SLOT_ALLOWED_POSITIONS[a]?.length ?? 99) - (SLOT_ALLOWED_POSITIONS[b]?.length ?? 99)
        return byFlex === 0 ? a.localeCompare(b) : byFlex
    })
}

async function loadStarterSlots(leagueId: string): Promise<string[]> {
    const templates = await fetchAllPages<LineupSlotTemplate>((from, to) => supabase
        .from('lineup_slot_templates')
        .select('slot_type, slot_count')
        .eq('league_id', leagueId)
        .order('slot_type')
        .range(from, to))

    const slots: string[] = []
    for (const template of templates) {
        if (template.slot_type === 'BE' || template.slot_type === 'IR') continue
        if (!SLOT_ALLOWED_POSITIONS[template.slot_type]) continue
        const count = Number(template.slot_count ?? 0)
        for (let i = 0; i < count; i += 1) {
            slots.push(template.slot_type)
        }
    }
    return sortSlotsByFlexibility(slots)
}

function bestLineupPointsForDate(candidates: LineupCandidate[], starterSlots: string[]): number {
    if (candidates.length === 0 || starterSlots.length === 0) return 0

    const memo = new Map<string, number>()

    function dfs(slotIndex: number, usedMask: bigint): number {
        if (slotIndex >= starterSlots.length) return 0

        const key = `${slotIndex}:${usedMask.toString()}`
        const cached = memo.get(key)
        if (cached != null) return cached

        const slotType = starterSlots[slotIndex]
        let best = dfs(slotIndex + 1, usedMask)
        for (let i = 0; i < candidates.length; i += 1) {
            const bit = 1n << BigInt(i)
            if ((usedMask & bit) !== 0n) continue

            const candidate = candidates[i]
            if (!canPlayStarterSlot(candidate.eligible_positions, slotType)) continue

            best = Math.max(best, candidate.points + dfs(slotIndex + 1, usedMask | bit))
        }

        memo.set(key, best)
        return best
    }

    return dfs(0, 0n)
}

async function loadLineupRows(
    memberIds: string[],
    leagueSeasonId: string,
    weekNumber: number,
): Promise<LineupSlot[]> {
    return fetchAllPages<LineupSlot>((from, to) => supabase
        .from('weekly_lineups')
        .select('member_id, player_id, slot_type, game_date')
        .in('member_id', memberIds)
        .eq('league_season_id', leagueSeasonId)
        .eq('week_number', weekNumber)
        .neq('slot_type', 'BE')
        .neq('slot_type', 'IR')
        .order('member_id')
        .order('game_date')
        .order('slot_type')
        .order('player_id')
        .order('id')
        .range(from, to))
}

async function loadPlayerPointsForWeek(
    playerIds: string[],
    seasonYear: number,
    settings: Record<string, number>,
    weekStart: string,
    weekEnd: string,
): Promise<PlayerPointsForWeek> {
    if (playerIds.length === 0) {
        return { pointsByPlayerDate: new Map(), rosterCutoffByPlayerDate: new Map() }
    }

    const stats = await fetchAllPages<StatRow>((from, to) => supabase
        .from('player_game_stats')
        .select(
            'player_id,game_date,points,rebounds,assists,steals,blocks,turnovers,' +
                'three_pointers_made,field_goals_made,field_goals_attempted,' +
                'free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play,' +
                'nba_games!inner(nba_game_id,game_time,started_at)',
        )
        .in('player_id', playerIds)
        .eq('season_year', seasonYear)
        .gte('game_date', weekStart)
        .lte('game_date', weekEnd)
        .order('player_id')
        .order('game_date')
        .order('id')
        .range(from, to)
        // The concatenated select string defeats PostgREST's response typing.
        .returns<StatRow[]>())

    const pointsByPlayerDate = new Map<string, number>()
    const rosterCutoffByPlayerDate = new Map<string, string>()
    for (const stat of stats) {
        if (!isRegularSeasonGameId(stat.nba_games?.nba_game_id)) continue
        const key = `${stat.player_id}|${stat.game_date}`
        const current = pointsByPlayerDate.get(key) ?? 0
        pointsByPlayerDate.set(
            key,
            current + calculateFantasyPoints(snakeToStatLine(stat), settings),
        )
        const cutoff = statRosterCutoff(stat)
        const currentCutoff = rosterCutoffByPlayerDate.get(key)
        if (!currentCutoff || cutoff < currentCutoff) {
            rosterCutoffByPlayerDate.set(key, cutoff)
        }
    }

    return { pointsByPlayerDate, rosterCutoffByPlayerDate }
}

async function loadActualLineupPointsInput(
    memberIds: string[],
    leagueSeasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
    weekStart: string,
    weekEnd: string,
): Promise<ActualLineupPointsInput | null> {
    const lineupRows = await loadLineupRows(memberIds, leagueSeasonId, weekNumber)
    if (lineupRows.length === 0) return null

    const playerIds = [...new Set(lineupRows.map((row) => row.player_id))]
    const { pointsByPlayerDate } = await loadPlayerPointsForWeek(
        playerIds,
        seasonYear,
        settings,
        weekStart,
        weekEnd,
    )

    return { lineupRows, pointsByPlayerDate }
}

async function loadMaxPossiblePointsInput(
    memberIds: string[],
    leagueSeasonId: string,
    seasonYear: number,
    settings: Record<string, number>,
    weekStart: string,
    weekEnd: string,
): Promise<MaxPossiblePointsInput> {
    const rosterRows = await fetchAllPages<RosterPlayerForScore>((from, to) => supabase
        .from('roster_players')
        .select('member_id, player_id, acquired_at, is_on_ir, is_on_taxi, players(position, eligible_positions)')
        .in('member_id', memberIds)
        .eq('league_season_id', leagueSeasonId)
        .eq('is_on_ir', false)
        .eq('is_on_taxi', false)
        .order('member_id')
        .order('player_id')
        .order('id')
        .range(from, to))

    const rosterTransactionRows = await fetchAllPages<RosterTransactionForScore>((from, to) => supabase
        .from('roster_transactions')
        .select('id, member_id, player_id, transaction_type, occurred_at, players(position, eligible_positions)')
        .in('member_id', memberIds)
        .eq('league_season_id', leagueSeasonId)
        .in('transaction_type', ROSTER_HISTORY_TRANSACTION_TYPES)
        .lte('occurred_at', endOfETDayUTC(weekEnd))
        .order('member_id')
        .order('player_id')
        .order('occurred_at')
        .order('id')
        .range(from, to))

    const playerIds = [
        ...new Set([...rosterRows, ...rosterTransactionRows].map((row) => row.player_id)),
    ]
    const playerPoints = await loadPlayerPointsForWeek(
        playerIds,
        seasonYear,
        settings,
        weekStart,
        weekEnd,
    )

    return { ...playerPoints, rosterRows, rosterTransactionRows }
}

export async function calcWeekPointsByMember(
    memberIds: string[],
    leagueSeasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
    weekStart: string,
    weekEnd: string,
): Promise<Map<string, number>> {
    if (memberIds.length === 0) return new Map()

    const loaded = await loadActualLineupPointsInput(
        memberIds,
        leagueSeasonId,
        seasonYear,
        weekNumber,
        settings,
        weekStart,
        weekEnd,
    )
    if (!loaded) return new Map(memberIds.map((id) => [id, 0]))
    const { lineupRows, pointsByPlayerDate } = loaded

    const pointsByMember = new Map(memberIds.map((id) => [id, 0]))
    for (const row of lineupRows) {
        pointsByMember.set(
            row.member_id,
            (pointsByMember.get(row.member_id) ?? 0) + (pointsByPlayerDate.get(`${row.player_id}|${row.game_date}`) ?? 0),
        )
    }

    for (const [memberId, points] of pointsByMember) {
        pointsByMember.set(memberId, roundFantasyPoints(points))
    }

    return pointsByMember
}

export async function calcWeekMaxPossiblePointsByMember(
    memberIds: string[],
    leagueId: string,
    leagueSeasonId: string,
    seasonYear: number,
    settings: Record<string, number>,
    weekStart: string,
    weekEnd: string,
): Promise<Map<string, number>> {
    if (memberIds.length === 0) return new Map()

    const starterSlots = await loadStarterSlots(leagueId)
    if (starterSlots.length === 0) return new Map(memberIds.map((id) => [id, 0]))

    const loaded = await loadMaxPossiblePointsInput(
        memberIds,
        leagueSeasonId,
        seasonYear,
        settings,
        weekStart,
        weekEnd,
    )
    const { pointsByPlayerDate, rosterCutoffByPlayerDate, rosterRows, rosterTransactionRows } = loaded
    const rosterEligibilityAtCutoff = buildRosterEligibilityAtCutoff(rosterRows, rosterTransactionRows)

    const candidatesByMemberDate = new Map<string, Map<string, LineupCandidate[]>>()
    for (const [key, points] of pointsByPlayerDate) {
        const [playerId, gameDate] = key.split('|')
        const cutoff = rosterCutoffByPlayerDate.get(key) ?? endOfETDayUTC(gameDate)
        for (const memberId of memberIds) {
            const eligiblePositions = rosterEligibilityAtCutoff(memberId, playerId, cutoff)
            if (eligiblePositions.length === 0) continue
            const dateCandidatesByMember = candidatesByMemberDate.get(memberId) ?? new Map<string, LineupCandidate[]>()
            const candidates = dateCandidatesByMember.get(gameDate) ?? []
            candidates.push({
                points,
                eligible_positions: eligiblePositions,
            })
            dateCandidatesByMember.set(gameDate, candidates)
            candidatesByMemberDate.set(memberId, dateCandidatesByMember)
        }
    }

    const maxPointsByMember = new Map<string, number>()
    for (const memberId of memberIds) {
        let maxPoints = 0
        for (const candidates of candidatesByMemberDate.get(memberId)?.values() ?? []) {
            maxPoints += bestLineupPointsForDate(candidates, starterSlots)
        }
        maxPointsByMember.set(memberId, roundFantasyPoints(maxPoints))
    }

    return maxPointsByMember
}

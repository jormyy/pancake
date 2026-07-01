import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'
import { supabase } from '../_shared/supabase.ts'
import { toETDate } from '../_shared/date.ts'
import { SLOT_ELIGIBLE } from '../../../constants/slots.ts'

type OptimizerSetting = {
  league_id: string
  league_season_id: string
  member_id: string
}
type LeagueRow = {
  status: string
}
type SeasonRow = {
  season_year: number
  is_current: boolean
}
type DateContext = {
  date: string
  seasonYear: number
  weekNumber: number
}
type RosterPlayerRow = {
  player_id: string
  players: {
    position: string | null
    eligible_positions: string[] | null
    nba_team: string | null
    injury_status: string | null
  } | null
}
type StarterTemplate = {
  slot_type: string
  slot_count: number
}
type AutoSetPlayer = {
  playerId: string
  eligiblePositions: string[]
  nbaTeam: string | null
  projected: number
  avoidInLineup: boolean
}
type GameRow = {
  season_year: number
  game_date: string
  home_team: string | null
  away_team: string | null
  status: string | null
  game_time: string | null
}
type WeeklyLineupRow = {
  player_id: string
  slot_type: string
}
type AssignmentScore = {
  filled: number
  healthy: number
  game: number
  projected: number
}
type AssignmentResult = {
  assignments: { playerId: string; slotType: string }[]
  score: AssignmentScore
}
type ProjectionRow = {
  player_id: string
  projection_fantasy_points: number | null
}
type UntypedSupabase = typeof supabase & {
  rpc: (fn: string, args?: Record<string, unknown>) => any
}

const FILL_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']
const db = supabase as UntypedSupabase

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const requestedDate = typeof body.date === 'string' ? body.date : null
    const result = await processEnabledLineupOptimizers(requestedDate)
    return Response.json({ ok: true, ...result })
  } catch (error: unknown) {
    return internalServerError('lineup-optimizer', error)
  }
})

async function processEnabledLineupOptimizers(requestedDate: string | null): Promise<{
  settings: number
  dates: number
  optimized: number
  skipped: number
}> {
  const dateContexts = await loadDateContexts(requestedDate)
  if (dateContexts.length === 0) return { settings: 0, dates: 0, optimized: 0, skipped: 0 }

  const { data: settings, error: settingsError } = await supabase
    .from('lineup_optimizer_settings')
    .select('league_id, league_season_id, member_id')
    .eq('enabled', true)
  if (settingsError) throw settingsError

  let optimized = 0
  let skipped = 0
  for (const setting of (settings ?? []) as OptimizerSetting[]) {
    const league = await loadLeague(setting.league_id)
    const season = await loadSeason(setting.league_id, setting.league_season_id)
    if (!season?.is_current || !['active', 'playoffs'].includes(league?.status ?? '')) {
      skipped += dateContexts.length
      continue
    }

    for (const dateContext of dateContexts) {
      if (dateContext.seasonYear !== season.season_year) {
        skipped++
        continue
      }
      await autoSetMemberDate(setting, dateContext)
      optimized++
    }
  }

  return {
    settings: (settings ?? []).length,
    dates: dateContexts.length,
    optimized,
    skipped,
  }
}

async function loadDateContexts(requestedDate: string | null): Promise<DateContext[]> {
  const today = toETDate(new Date())
  const end = addDays(today, 7)
  let query = supabase
    .from('nba_games')
    .select('season_year, game_date, home_team, away_team, status, game_time')
    .order('game_date', { ascending: true })
    .order('game_time', { ascending: true })

  if (requestedDate) {
    query = query.eq('game_date', requestedDate)
  } else {
    query = query.gte('game_date', today).lte('game_date', end)
  }

  const { data, error } = await query
  if (error) throw error

  const now = new Date().toISOString()
  const byDate = new Map<string, GameRow[]>()
  for (const game of (data ?? []) as GameRow[]) {
    const games = byDate.get(game.game_date) ?? []
    games.push(game)
    byDate.set(game.game_date, games)
  }

  const contexts: DateContext[] = []
  for (const [date, games] of byDate) {
    const anyStarted = games.some((game) =>
      ['InProgress', 'Final'].includes(game.status ?? '') ||
      (game.game_time != null && game.game_time <= now)
    )
    if (anyStarted) continue

    const seasonYear = games[0]?.season_year
    const weekNumber = await weekNumberForDate(seasonYear, date)
    if (weekNumber == null) continue
    contexts.push({ date, seasonYear, weekNumber })
  }
  return contexts
}

async function loadLeague(leagueId: string): Promise<LeagueRow | null> {
  const { data, error } = await supabase
    .from('leagues')
    .select('status')
    .eq('id', leagueId)
    .maybeSingle()
  if (error) throw error
  return data as LeagueRow | null
}

async function loadSeason(leagueId: string, seasonId: string): Promise<SeasonRow | null> {
  const { data, error } = await supabase
    .from('league_seasons')
    .select('season_year, is_current')
    .eq('id', seasonId)
    .eq('league_id', leagueId)
    .maybeSingle()
  if (error) throw error
  return data as SeasonRow | null
}

async function weekNumberForDate(seasonYear: number, gameDate: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('season_weeks')
    .select('week_number')
    .eq('season_year', seasonYear)
    .lte('week_start', gameDate)
    .gte('week_end', gameDate)
    .maybeSingle()
  if (error) throw error
  return data?.week_number ?? null
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

async function autoSetMemberDate(
  setting: OptimizerSetting,
  dateContext: DateContext,
): Promise<void> {
  const [{ data: roster, error: rosterErr }, { data: templates, error: templatesErr }] = await Promise.all([
    supabase
      .from('roster_players')
      .select('player_id, players(position, eligible_positions, nba_team, injury_status)')
      .eq('member_id', setting.member_id)
      .eq('league_id', setting.league_id)
      .eq('league_season_id', setting.league_season_id)
      .eq('is_on_ir', false)
      .eq('is_on_taxi', false),
    supabase
      .from('lineup_slot_templates')
      .select('slot_type, slot_count')
      .eq('league_id', setting.league_id),
  ])
  if (rosterErr) throw rosterErr
  if (templatesErr) throw templatesErr

  const rosterRows = (roster ?? []) as RosterPlayerRow[]
  const playerIds = rosterRows.map((row) => row.player_id)
  if (playerIds.length === 0) return

  const [{ data: projections, error: projectionErr }, { data: games, error: gamesErr }, { data: existingEntries, error: existingErr }] =
    await Promise.all([
      db.rpc('get_league_projection_rows', {
        p_league_id: setting.league_id,
        p_season_year: dateContext.seasonYear,
        p_game_date: dateContext.date,
        p_view: 'today',
        p_player_ids: playerIds,
        p_limit: Math.min(Math.max(playerIds.length, 1), 1000),
        p_offset: 0,
      }),
      supabase
        .from('nba_games')
        .select('home_team, away_team, status, game_time')
        .eq('season_year', dateContext.seasonYear)
        .eq('game_date', dateContext.date),
      supabase
        .from('weekly_lineups')
        .select('player_id, slot_type')
        .eq('member_id', setting.member_id)
        .eq('league_id', setting.league_id)
        .eq('league_season_id', setting.league_season_id)
        .eq('game_date', dateContext.date),
    ])
  if (projectionErr) throw projectionErr
  if (gamesErr) throw gamesErr
  if (existingErr) throw existingErr

  const projectionMap = new Map(
    ((projections ?? []) as ProjectionRow[]).map((row) => [row.player_id, Number(row.projection_fantasy_points ?? 0)]),
  )
  const players: AutoSetPlayer[] = rosterRows.map((row) => ({
    playerId: row.player_id,
    eligiblePositions: eligiblePositions(row.players),
    nbaTeam: row.players?.nba_team ?? null,
    projected: projectionMap.get(row.player_id) ?? 0,
    avoidInLineup: isAvoidedInjury(row.players?.injury_status ?? null),
  }))

  const playingTeams = new Set<string>()
  const startedTeams = new Set<string>()
  const now = new Date().toISOString()
  for (const game of (games ?? []) as GameRow[]) {
    if (game.home_team) playingTeams.add(game.home_team)
    if (game.away_team) playingTeams.add(game.away_team)
    const hasStarted =
      ['InProgress', 'Final'].includes(game.status ?? '') ||
      (game.game_time != null && game.game_time <= now)
    if (hasStarted) {
      if (game.home_team) startedTeams.add(game.home_team)
      if (game.away_team) startedTeams.add(game.away_team)
    }
  }

  const playerTeamMap = new Map(players.map((player) => [player.playerId, player.nbaTeam]))
  const lockedEntries: { playerId: string; slotType: string }[] = []
  const lockedPlayerIds = new Set<string>()
  for (const entry of (existingEntries ?? []) as WeeklyLineupRow[]) {
    const team = playerTeamMap.get(entry.player_id)
    if (team && startedTeams.has(team) && entry.slot_type !== 'BE' && entry.slot_type !== 'IR') {
      lockedPlayerIds.add(entry.player_id)
      lockedEntries.push({ playerId: entry.player_id, slotType: entry.slot_type })
    }
  }

  const starterTemplates = ((templates ?? []) as StarterTemplate[]).filter(
    (template) => !['BE', 'IR', 'TX'].includes(template.slot_type),
  )
  const slotsToFill = slotsForTemplates(starterTemplates, lockedEntries)
  const availablePlayers = players
    .filter((player) => !lockedPlayerIds.has(player.playerId))
    .sort((a, b) => b.projected - a.projected || a.playerId.localeCompare(b.playerId))
  const newAssignments = chooseBestAssignments(
    slotsToFill,
    availablePlayers,
    (player) => !!(player.nbaTeam && playingTeams.has(player.nbaTeam)),
  )

  const assignments = [
    ...lockedEntries.map((entry) => ({
      player_id: entry.playerId,
      slot_type: entry.slotType,
      is_auto_set: false,
      week_number: dateContext.weekNumber,
    })),
    ...newAssignments.map((entry) => ({
      player_id: entry.playerId,
      slot_type: entry.slotType,
      is_auto_set: true,
      week_number: dateContext.weekNumber,
    })),
  ]

  const { error } = await supabase.rpc('auto_set_lineup_atomic', {
    p_member_id: setting.member_id,
    p_league_id: setting.league_id,
    p_league_season_id: setting.league_season_id,
    p_game_date: dateContext.date,
    p_assignments: assignments,
  })
  if (error) throw error

  const { error: updateError } = await supabase
    .from('lineup_optimizer_settings')
    .update({ last_optimized_at: new Date().toISOString() })
    .eq('league_id', setting.league_id)
    .eq('league_season_id', setting.league_season_id)
    .eq('member_id', setting.member_id)
  if (updateError) throw updateError
}

function eligiblePositions(player: RosterPlayerRow['players']): string[] {
  if (player?.eligible_positions?.length) return player.eligible_positions
  return player?.position ? [player.position] : []
}

function isAvoidedInjury(injuryStatus: string | null): boolean {
  if (!injuryStatus) return false
  const status = injuryStatus.toLowerCase()
  return status === 'out' || status.startsWith('ir')
}

function slotsForTemplates(
  starterTemplates: StarterTemplate[],
  lockedEntries: { playerId: string; slotType: string }[],
): string[] {
  const lockedSlotCounts = new Map<string, number>()
  for (const entry of lockedEntries) {
    lockedSlotCounts.set(entry.slotType, (lockedSlotCounts.get(entry.slotType) ?? 0) + 1)
  }
  const templateMap = new Map(starterTemplates.map((template) => [template.slot_type, template.slot_count]))
  const slotOrder = [
    ...FILL_ORDER.filter((slot) => templateMap.has(slot)),
    ...([...templateMap.keys()].filter((slot) => !FILL_ORDER.includes(slot))),
  ]
  const result: string[] = []
  for (const slotType of slotOrder) {
    const remaining = (templateMap.get(slotType) ?? 0) - (lockedSlotCounts.get(slotType) ?? 0)
    for (let i = 0; i < remaining; i++) result.push(slotType)
  }
  return result
}

function emptyScore(): AssignmentScore {
  return { filled: 0, healthy: 0, game: 0, projected: 0 }
}

function addScore(score: AssignmentScore, player: AutoSetPlayer, hasGame: boolean): AssignmentScore {
  return {
    filled: score.filled + 1,
    healthy: score.healthy + (player.avoidInLineup ? 0 : 1),
    game: score.game + (hasGame ? 1 : 0),
    projected: score.projected + player.projected,
  }
}

function compareScore(a: AssignmentScore, b: AssignmentScore): number {
  return a.filled - b.filled || a.healthy - b.healthy || a.game - b.game || a.projected - b.projected
}

function chooseBestAssignments(
  slots: string[],
  players: AutoSetPlayer[],
  hasGame: (player: AutoSetPlayer) => boolean,
): { playerId: string; slotType: string }[] {
  const memo = new Map<string, AssignmentResult>()

  function used(mask: number, index: number): boolean {
    const bit = 2 ** index
    return Math.floor(mask / bit) % 2 === 1
  }

  function search(slotIndex: number, mask: number): AssignmentResult {
    if (slotIndex >= slots.length) return { assignments: [], score: emptyScore() }
    const key = `${slotIndex}:${mask}`
    const cached = memo.get(key)
    if (cached) return cached

    let best = search(slotIndex + 1, mask)
    const slotType = slots[slotIndex]
    const eligible = SLOT_ELIGIBLE[slotType] ?? []
    for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
      if (used(mask, playerIndex)) continue
      const player = players[playerIndex]
      if (!player.eligiblePositions.some((position) => eligible.includes(position))) continue

      const next = search(slotIndex + 1, mask + 2 ** playerIndex)
      const candidate: AssignmentResult = {
        assignments: [{ playerId: player.playerId, slotType }, ...next.assignments],
        score: addScore(next.score, player, hasGame(player)),
      }
      if (compareScore(candidate.score, best.score) > 0) best = candidate
    }

    memo.set(key, best)
    return best
  }

  return search(0, 0).assignments
}

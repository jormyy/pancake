import { estimateMatchup, sampleScoringVariation, type ForecastGame } from '../_shared/matchupForecast.ts'
import { chooseBestAssignments } from '../_shared/lineupAssignments.ts'

type Game = {
  id: string
  game_date: string
  home_team: string
  away_team: string
  status: string
  game_time: string | null
  started_at: string | null
  live_scoreboard_elapsed_seconds: number | null
  live_stats_elapsed_seconds: number | null
}
type Player = {
  member_id: string
  player_id: string
  is_on_ir: boolean
  is_on_taxi: boolean
  nba_team: string | null
  eligible_positions: string[] | null
  injury_status: string | null
}
type Projection = {
  requested_date: string
  player_id: string
  projection_fantasy_points: number | null
  projection_source_label: string | null
  projection_fetched_at: string | null
  projection_date: string | null
  projection_is_fresh: boolean | null
}
export type ForecastGameDetail = {
  gameId: string
  playerId: string
  memberId: string
  date: string
  projection: number | null
  source: string | null
  sourceAt: string | null
  remainingFraction: number | null
}
export type ForecastContext = {
  matchupId: string
  observedAt: string
  today: string
  weekEnd: string
  isFinalized: boolean
  teams: { memberId: string; currentPoints: number }[]
  roster: Player[]
  games: Game[]
  history: { player_id: string; scores: number[] }[]
  projections: Projection[]
  lineups: { member_id: string; player_id: string; game_date: string; slot_type: string; is_auto_set: boolean }[]
  templates: { slot_type: string; slot_count: number }[]
  automaticMembers: string[]
  previous: { games?: ForecastGameDetail[] } | null
}

function started(game: Game, now: number) {
  return game.status === 'InProgress' || game.status === 'Final' ||
    game.started_at !== null && Date.parse(game.started_at) <= now ||
    game.game_time !== null && Date.parse(game.game_time) <= now
}

function remaining(game: Game): number | null {
  if (game.status === 'Final') return 0
  if (game.status !== 'InProgress') return 1
  const elapsed = Math.max(game.live_scoreboard_elapsed_seconds ?? -1, game.live_stats_elapsed_seconds ?? -1)
  if (elapsed < 0) return null
  const duration = elapsed < 2880 ? 2880 : 2880 + (Math.floor((elapsed - 2880) / 300) + 1) * 300
  return Math.max(0, (duration - elapsed) / 2880)
}

export function computeForecast(context: ForecastContext) {
  const now = Date.parse(context.observedAt)
  if (!Number.isFinite(now)) throw new Error('Forecast observation time is invalid.')
  const missing = new Set<string>()
  const eligible = new Set<string>()
  const gameDetails: ForecastGameDetail[] = []
  const estimates: ForecastGame[] = []
  const history = new Map(context.history.map(row => [row.player_id, sampleScoringVariation(row.scores)]))
  const previous = new Map((context.previous?.games ?? []).map(row => [`${row.playerId}:${row.gameId}`, row]))
  const projections = new Map(context.projections.map(row => [`${row.player_id}:${row.requested_date}`, row]))
  const relevantGames = context.games.filter(game => !['Postponed', 'Cancelled'].includes(game.status))
  const playerGame = (player: Player, date: string) => relevantGames.find(game => game.game_date === date &&
    (game.home_team === player.nba_team || game.away_team === player.nba_team))
  const projectionFor = (player: Player, game: Game) => {
    const frozen = previous.get(`${player.player_id}:${game.id}`)
    if (started(game, now)) return frozen ?? null
    const row = projections.get(`${player.player_id}:${game.game_date}`)
    if (!row || row.projection_date !== game.game_date || !row.projection_is_fresh ||
      row.projection_fetched_at !== null && Date.parse(row.projection_fetched_at) > now) return null
    return { projection: row.projection_fantasy_points, source: row.projection_source_label, sourceAt: row.projection_fetched_at }
  }
  for (const date of [...new Set(relevantGames.map(game => game.game_date))]) {
    for (const team of context.teams) {
      const saved = context.lineups.filter(row => row.member_id === team.memberId && row.game_date === date)
      const roster = context.roster.filter(row => row.member_id === team.memberId && !row.is_on_ir && !row.is_on_taxi)
      const automatic = context.automaticMembers.includes(team.memberId)
      const fixed = saved.filter(row => {
        const player = roster.find(player => player.player_id === row.player_id)
        const game = player && playerGame(player, date)
        return !automatic || game && started(game, now)
      })
      for (const row of fixed) if (!['BE', 'IR'].includes(row.slot_type)) eligible.add(`${row.player_id}:${date}`)
      if (!automatic) continue
      const occupied = new Set(fixed.map(row => row.player_id))
      const slots = context.templates.flatMap(template => Array.from({ length: Math.max(0,
        template.slot_count - fixed.filter(row => row.slot_type === template.slot_type).length,
      ) }, () => template.slot_type))
      const players = roster.flatMap(player => {
        const game = playerGame(player, date)
        const injury = player.injury_status?.toLowerCase() ?? ''
        if (!game || occupied.has(player.player_id) || started(game, now) || injury === 'out' || injury.startsWith('ir')) return []
        const projection = projectionFor(player, game)
        if (projection?.projection === null || !projection) missing.add(`Lineup projection unavailable: ${player.player_id}`)
        return [{ playerId: player.player_id, eligiblePositions: player.eligible_positions ?? [],
          projected: projection?.projection ?? 0, avoidInLineup: false }]
      })
      for (const assignment of chooseBestAssignments(slots, players, () => true, 'projection')) eligible.add(`${assignment.playerId}:${date}`)
    }
  }
  for (const player of context.roster) {
    for (const game of relevantGames) {
      if (game.home_team !== player.nba_team && game.away_team !== player.nba_team) continue
      if (!eligible.has(`${player.player_id}:${game.game_date}`) || game.status === 'Final') continue
      const fraction = remaining(game)
      const projection = projectionFor(player, game)
      const variation = history.get(player.player_id)
      if (fraction === null) missing.add(`Live progress unavailable: ${game.id}`)
      if (game.status !== 'InProgress' && started(game, now)) missing.add(`Game status unavailable: ${game.id}`)
      gameDetails.push({ gameId: game.id, playerId: player.player_id, memberId: player.member_id,
        date: game.game_date, projection: projection?.projection ?? null, source: projection?.source ?? null,
        sourceAt: projection?.sourceAt ?? null, remainingFraction: fraction })
      estimates.push({ gameId: game.id, playerId: player.player_id, memberId: player.member_id,
        expectedPoints: projection?.projection !== null && projection && fraction !== null ? projection.projection * fraction : null,
        variance: variation && fraction !== null ? variation.variance * fraction : null, completed: false, eligible: true })
    }
  }
  if (!context.isFinalized && context.today <= context.weekEnd && context.games.length === 0) missing.add('Schedule unavailable')
  return { ...estimateMatchup(context.teams, estimates, [...missing]), games: gameDetails,
    lineupBasis: 'Saved lineups and enabled automatic lineups' }
}

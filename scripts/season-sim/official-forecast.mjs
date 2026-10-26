import assert from 'node:assert/strict'
import { sql, sqlJson } from './local-stack.mjs'
import { statPoints } from './score-oracle.mjs'
import { maximumAssignment } from './position-oracle.mjs'

export function forecastSplit(week, type) {
  if (week >= 17 || type !== 'regular_season') return 'final-held-out'
  return [10, 13, 16].includes(week) ? 'calibration-held-out' : 'development'
}

export function scoreForecastReceipt(receipt, matchup) {
  assert.ok(matchup.is_finalized)
  const outcome = matchup.home_points === matchup.away_points ? 0.5 : Number(matchup.home_points > matchup.away_points)
  const home = receipt.forecast?.teams?.find(row => row.memberId === matchup.home_member_id)
  const probability = home?.winProbability ?? null
  if (probability !== null) assert.ok(Number.isFinite(probability) && probability >= 0 && probability <= 1)
  const baselineHome = receipt.baseline.find(row => row.memberId === matchup.home_member_id)?.mean
  const baselineAway = receipt.baseline.find(row => row.memberId === matchup.away_member_id)?.mean
  const meanPrediction = baselineHome == null || baselineAway == null ? null : baselineHome === baselineAway ? 0.5 : Number(baselineHome > baselineAway)
  return { outcome, homePoints: matchup.home_points, awayPoints: matchup.away_points, brier: probability == null ? null : (probability - outcome) ** 2, constantBrier: (0.5 - outcome) ** 2, meanWinnerBrier: meanPrediction == null ? null : (meanPrediction - outcome) ** 2 }
}

export async function captureOfficialForecasts(c, date, week, report) {
  report.forecasts ??= []
  if (await sql("SELECT to_regprocedure('public.get_matchup_forecast_context(uuid)') IS NOT NULL") !== 't') {
    report.forecastUnavailable = 'The forecast worker is not installed in this diagnostic build'
    return
  }
  const weekStart = await sql(`SELECT week_start FROM season_weeks WHERE season_year=${c.seasonYear} AND week_number=${week}`)
  const matchups = await c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}&week_number=eq.${week}&is_voided=eq.false`)
  if (!matchups.length) {
    report.forecastMissingWeeks ??= []
    if (!report.forecastMissingWeeks.some(row => row.seasonId === c.leagueSeasonId && row.week === week)) report.forecastMissingWeeks.push({ seasonId: c.leagueSeasonId, week, date, reason: 'No matchup exists at the requested forecast checkpoint' })
  }
  for (const matchup of matchups) {
    if (report.forecasts.some(row => row.matchupId === matchup.id)) continue
    const context = await sqlJson(`SELECT public.get_matchup_forecast_context('${matchup.id}')`, 'Forecast source receipt')
    const forecast = await c.rpc(c.users[0], 'get_matchup_forecast', { p_matchup_id: matchup.id })
    const settings = (await c.rest(c.users[0], `leagues?select=scoring_settings&id=eq.${c.leagueId}`))[0].scoring_settings
    const history = await sqlJson(`SELECT coalesce(json_agg(h ORDER BY player_id,game_date,game_id),'[]') FROM (SELECT p.*,g.game_date,row_number() OVER(PARTITION BY p.player_id ORDER BY g.game_date DESC,p.id) AS recency FROM player_game_stats p JOIN nba_games g ON g.id=p.game_id WHERE g.game_date<'${date}' AND g.status='Final' AND g.nba_game_id LIKE '002%' AND NOT p.did_not_play AND g.season_year BETWEEN ${c.seasonYear - 1} AND ${c.seasonYear} AND p.player_id IN (SELECT player_id FROM roster_players WHERE league_season_id='${c.leagueSeasonId}' AND member_id IN ('${matchup.home_member_id}','${matchup.away_member_id}'))) h WHERE recency<=30`, 'Independent prior-only forecast history')
    const means = new Map()
    for (const player of context.roster) {
      const rows = history.filter(row => row.player_id === player.player_id)
      assert.ok(rows.every(row => row.game_date < date), 'Forecast training contains no current or future game')
      const scores = rows.map(row => statPoints(row, settings))
      const provided = context.history.find(row => row.player_id === player.player_id)?.scores ?? []
      assert.deepEqual([...provided].sort((a, b) => a - b), [...scores].sort((a, b) => a - b), 'Forecast history agrees with independently scored prior games')
      means.set(player.player_id, scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null)
    }
    for (const projection of context.projections) if (projection.projection_fetched_at) assert.ok(Date.parse(projection.projection_fetched_at) <= Date.parse(context.observedAt), 'Forecast source is available before prediction')
    const baseline = context.teams.map(team => {
      const assignments = [], missing = new Set()
      for (const day of [...new Set(context.games.map(game => game.game_date))]) {
        const candidates = context.roster.filter(player => player.member_id === team.memberId && !player.is_on_ir && !player.is_on_taxi && !/^(out|ir)/i.test(player.injury_status ?? '')).flatMap(player => {
          const games = context.games.filter(game => game.game_date === day && ['Scheduled', 'InProgress'].includes(game.status) && [game.home_team, game.away_team].includes(player.nba_team))
          if (!games.length) return []
          const mean = means.get(player.player_id)
          if (mean == null) { missing.add(player.player_id); return [] }
          return [{ ...player, points: mean * games.length, games: games.map(game => game.id) }]
        })
        const result = maximumAssignment(candidates, context.templates)
        assignments.push({ day, ...result, candidates })
      }
      return { memberId: team.memberId, mean: missing.size ? null : team.currentPoints + assignments.reduce((sum, row) => sum + row.points, 0), missing: [...missing], assignments }
    })
    report.forecasts.push({ matchupId: matchup.id, week, preweek: date === weekStart && context.teams.every(team => team.currentPoints === 0) && !context.games.some(game => game.game_time && Date.parse(game.game_time) <= Date.parse(context.observedAt)), split: forecastSplit(week, matchup.matchup_type), at: context.observedAt, forecast, context, history, baseline, source: 'Prior ingested final games; no future means. Stored production projection provenance remains attached.' })
  }
}

export async function scoreOfficialForecasts(c, report) {
  const pending = (report.forecasts ?? []).filter(row => !row.outcome)
  if (!pending.length) return
  const rows = await c.rest(c.users[0], `matchups?select=*&league_id=eq.${c.leagueId}&is_finalized=eq.true&is_voided=eq.false`)
  for (const receipt of pending) {
    const matchup = rows.find(row => row.id === receipt.matchupId)
    if (matchup) receipt.outcome = scoreForecastReceipt(receipt, matchup)
  }
}

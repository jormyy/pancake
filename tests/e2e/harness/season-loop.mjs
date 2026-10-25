import { isDeepStrictEqual } from 'node:util'
import { backendJson, postJson } from '../soak-network.mjs'
import { calendarWeeksForLeague, seasonYearForDate } from './season-calendar.mjs'
import { querySupabaseDb } from '../env.mjs'
import { readSchedule } from './schedule.mjs'

const readBoundaryReadiness = (env, leagueId, seasonId, action) => {
  try {
    if (!env?.supabaseUrl || !['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'].includes(new URL(env.supabaseUrl).hostname)) {
      throw new Error('Readiness diagnostics require the project local stack')
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuid.test(leagueId) || !uuid.test(seasonId) || !['generate', 'advance', 'rollover'].includes(action)) {
      throw new Error('Readiness diagnostics require valid league, season and action inputs')
    }
    const rows = querySupabaseDb('local', 'soak boundary readiness', `
      WITH scope AS (
        SELECT season.id, season.season_year, season.is_current, league.status,
          coalesce(season.playoff_start_week, league.playoff_start_week, 20) AS playoff_start_week
        FROM public.league_seasons season JOIN public.leagues league ON league.id = season.league_id
        WHERE season.id = '${seasonId}'::uuid AND season.league_id = '${leagueId}'::uuid
      ), phase AS (
        SELECT CASE WHEN '${action}' = 'generate' THEN 'regular_season'
          WHEN '${action}' = 'rollover' THEN 'playoff_final'
          WHEN EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id = '${seasonId}'::uuid
            AND matchup_type = 'playoff_semifinal') THEN 'playoff_semifinal'
          ELSE 'playoff_quarterfinal' END AS matchup_type
      ), phase_rows AS (
        SELECT matchup.* FROM public.matchups matchup CROSS JOIN scope CROSS JOIN phase
        WHERE matchup.league_season_id = scope.id AND matchup.matchup_type::text = phase.matchup_type
          AND (phase.matchup_type <> 'regular_season' OR matchup.week_number < scope.playoff_start_week)
      )
      SELECT jsonb_build_object(
        'leagueSeasonId', scope.id, 'seasonYear', scope.season_year, 'isCurrent', scope.is_current,
        'leagueStatus', scope.status, 'playoffStartWeek', scope.playoff_start_week, 'phase', phase.matchup_type,
        'matchupCount', (SELECT count(*) FROM phase_rows),
        'finalizedCount', (SELECT count(*) FROM phase_rows WHERE is_finalized IS TRUE),
        'winnerCount', (SELECT count(*) FROM phase_rows WHERE winner_member_id IS NOT NULL),
        'latestFinalizedAt', (SELECT max(finalized_at) FROM phase_rows),
        'certificateCount', (SELECT count(*) FROM private.score_week_certificates WHERE league_season_id = scope.id)
      ) AS readiness FROM scope CROSS JOIN phase
    `)
    const readiness = rows?.[0]?.readiness
    if (!readiness) throw new Error('Current league season not found in the local database')
    return typeof readiness === 'string' ? JSON.parse(readiness) : readiness
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) }
  }
}

const applySoakBoundary = async ({ supabase, env, leagueId, season }, action) => {
  const referenceAt = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase.rpc('apply_season_boundary_after_grace', {
    p_league_id: leagueId, p_league_season_id: season.id, p_action: action,
    p_reference_at: referenceAt,
  })
  if (error || data?.applied !== true) {
    const diagnostics = {
      rpcPayload: data ?? null, referenceAt,
      rpcError: error ? { code: error.code, message: error.message } : null,
      readiness: readBoundaryReadiness(env, leagueId, season.id, action),
    }
    throw new Error(`Soak ${action} boundary ${error ? `failed: ${error.message}` : 'declined'}; diagnostics=${JSON.stringify(diagnostics)}`)
  }
  return data
}

export const rolloverSoakSeason = async (context) => {
  const result = await applySoakBoundary(context, 'rollover')
  return { newSeasonId: result.new_season_id, newYear: result.new_year }
}

export const readSoakSeason = async (supabase, leagueId) => {
  const [{ data: season, error: seasonError }, { data: league, error: leagueError }] = await Promise.all([
    supabase.from('league_seasons').select('id, season_year').eq('league_id', leagueId).eq('is_current', true).single(),
    supabase.from('leagues').select('playoff_start_week, playoff_total_weeks, playoff_round_weeks').eq('id', leagueId).single(),
  ])
  if (seasonError || leagueError || !season || !league) {
    throw new Error(`Soak season read failed: ${seasonError?.message ?? leagueError?.message ?? 'missing league or season'}`)
  }
  return { ...season, ...league, calendarWeeks: calendarWeeksForLeague(league) }
}

export const prepareSoakSeason = async ({ supabase, env, leagueId, season }) => {
  const count = async (table, filters) => {
    let query = supabase.from(table).select('id', { count: 'exact', head: true }).eq('league_id', leagueId)
    for (const [key, value] of Object.entries(filters)) query = query.eq(key, value)
    const { count: total, error } = await query
    if (error || total == null) throw new Error(`Soak ${table} count failed: ${error?.message ?? 'missing count'}`)
    return total
  }
  const members = await count('league_members', {})
  if (members < 4) throw new Error('The season loop requires at least four league members')
  const expected = ((season.playoff_start_week ?? 20) - 1) * Math.floor(members / 2)
  const before = await readSchedule(supabase, leagueId, season.id)
  // The seed contains one matchup for browser latency. Replace that incomplete
  // fixture through the guarded API, which refuses a started schedule.
  const force = before.length > 0 && before.length !== expected
  if (force) {
    const { data: first, error } = await supabase.from('season_weeks').select('week_start')
      .eq('season_year', season.season_year).order('week_number').limit(1).single()
    if (error || !first?.week_start) throw new Error('Soak schedule requires its first calendar week')
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    if (today >= first.week_start) throw new Error('Cannot rebuild an incomplete schedule after its first week starts')
  }
  await backendJson(env, '/e2e/generate-matchups', { leagueId, force })
  const after = await readSchedule(supabase, leagueId, season.id)
  if (!force && before.length > 0 && !isDeepStrictEqual(after, before)) throw new Error('Existing schedule changed after non-force generation')
  if (after.length !== expected) throw new Error(`Soak regular schedule has ${after.length} matchups; expected ${expected}`)
  // This owned simulation fixture enters its regular season here. Draft/reset
  // workflows run separately through their guarded scenario contracts.
  const { error } = await supabase.from('leagues').update({ status: 'active' }).eq('id', leagueId)
  if (error) throw new Error(`Soak active-season fixture failed: ${error.message}`)
}

const removeSupersededFakeGames = async (supabase, fake, season) => {
  const year = season.season_year - 1
  const fixtures = season.season_year === 2027 ? [
    { ids: ['FAKE0001', '002FAKE0001'], date: `${year}-10-20`, home: 'NYK', away: 'BOS' },
    { ids: ['FAKE0002', '002FAKE0002'], date: `${year}-10-21`, home: 'BOS', away: 'LAL' },
  ] : [
    { ids: [`FAKE${season.season_year}01`, `002FAKE${season.season_year}01`], date: `${year}-10-20`, home: 'BOS', away: 'UTA' },
  ]
  const { data: games, error } = await supabase.from('nba_games')
    .select('id, nba_game_id, season_year, game_date, home_team, away_team, status, stats_synced_at')
    .eq('season_year', season.season_year).in('nba_game_id', fixtures.flatMap((fixture) => fixture.ids))
  if (error) throw new Error(`Soak legacy fake game read failed: ${error.message}`)
  const superseded = (games ?? []).filter((game) => game.season_year === season.season_year &&
    !fake.state.games.has(game.nba_game_id) && fixtures.some((fixture) => fixture.ids.includes(game.nba_game_id) &&
      fixture.date === game.game_date && fixture.home === game.home_team && fixture.away === game.away_team))
  if (!superseded.length) return
  if (superseded.some((game) => game.status !== 'Scheduled' || game.stats_synced_at != null)) {
    throw new Error('Soak legacy fake games have completion evidence; refusing to remove them')
  }
  const ids = superseded.map((game) => game.id)
  const { count, error: statsError } = await supabase.from('player_game_stats')
    .select('id', { count: 'exact', head: true }).in('game_id', ids)
  if (statsError || count == null) throw new Error(`Soak legacy fake stats read failed: ${statsError?.message ?? 'missing count'}`)
  if (count > 0) throw new Error('Soak legacy fake games have stored stats; refusing to remove them')
  const { data: removed, error: removeError } = await supabase.from('nba_games').delete()
    .eq('season_year', season.season_year).eq('status', 'Scheduled').is('stats_synced_at', null).in('id', ids).select('id')
  if (removeError) throw new Error(`Soak legacy fake game removal failed: ${removeError.message}`)
  if (removed?.length !== ids.length) throw new Error('Soak legacy fake games changed during removal')
}

export const completeSoakSeason = async ({ supabase, env, fake, fakePort, leagueId, season }) => {
  if (fake.state.seasonYear !== season.season_year) throw new Error('Fake calendar does not match the current league season')
  const dates = [...new Set([...fake.state.games.values()]
    .filter((game) => seasonYearForDate(game.gameDate) === season.season_year).map((game) => game.gameDate))].sort()
  if (!dates.length) throw new Error('The current fake season has no games')
  await removeSupersededFakeGames(supabase, fake, season)
  await postJson(`http://127.0.0.1:${fakePort}/admin/complete-season`, {})
  await backendJson(env, '/e2e/sync-schedule')
  for (const date of dates) {
    const reference = `${date}T23:59:59Z`
    await postJson(`http://127.0.0.1:${fakePort}/admin/now`, { now: reference })
    await backendJson(env, '/e2e/sync-stats', { date: reference, leagueId })
  }
  // Past the last round and the correction window; complete box scores stay settled.
  const reference = new Date(Date.parse(`${dates.at(-1)}T12:00:00Z`) + 5 * 86_400_000).toISOString()
  const boundary = (action) => applySoakBoundary({ supabase, env, leagueId, season }, action)
  await backendJson(env, '/e2e/sync-scores', { date: reference, leagueId })
  await boundary('generate')
  for (let round = 0; round < 3; round += 1) {
    await backendJson(env, '/e2e/sync-scores', { date: reference, leagueId })
    const { data: finals, error } = await supabase.from('matchups')
      .select('id, winner_member_id, is_finalized').eq('league_season_id', season.id).eq('matchup_type', 'playoff_final')
    if (error) throw new Error(`Soak final read failed: ${error.message}`)
    if (finals?.length === 1 && finals[0].is_finalized && finals[0].winner_member_id) return
    await boundary('advance')
  }
  throw new Error('Soak season has no finalized champion after three rounds')
}

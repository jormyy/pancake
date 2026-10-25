import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fixtureStore } from './fixtures.mjs'
import { season, fixtureDirectory, miniRoot, writeJson } from './common.mjs'
import { checkBoundaryWait } from './boundary-clock.mjs'
import { fixtureNbaId } from './fixture-identities.mjs'
import { sql, sqlJson } from './local-stack.mjs'

const fields = { points: 'points', assists: 'assists', rebounds: 'reboundsTotal', offensive_rebounds: 'reboundsOffensive', defensive_rebounds: 'reboundsDefensive', steals: 'steals', blocks: 'blocks', turnovers: 'turnovers', personal_fouls: 'foulsPersonal', field_goals_made: 'fieldGoalsMade', field_goals_attempted: 'fieldGoalsAttempted', three_pointers_made: 'threePointersMade', three_pointers_attempted: 'threePointersAttempted', free_throws_made: 'freeThrowsMade', free_throws_attempted: 'freeThrowsAttempted', plus_minus: 'plusMinusPoints' }

function assertFinalPlayer(stored, expected) {
  for (const [column, source] of Object.entries(fields)) assert.equal(stored[column], expected.statistics[source], `${expected.name}: ${column}`)
  const minutes = /^PT(\d+)M([\d.]+)S$/.exec(expected.statistics.minutes)
  assert.ok(minutes)
  assert.equal(stored.minutes_played, Math.round((Number(minutes[1]) + Number(minutes[2]) / 60) * 100) / 100, `${expected.name}: minutes`)
  assert.equal(stored.did_not_play, expected.played === '0', `${expected.name}: DNP`)
  const doubles = ['points', 'reboundsTotal', 'assists', 'steals', 'blocks'].filter(field => expected.statistics[field] >= 10).length
  assert.equal(stored.double_double, doubles >= 2)
  assert.equal(stored.triple_double, doubles >= 3)
}

export async function assertFinals(date) {
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
  const store = await fixtureStore(fixtureDirectory)
  const rows = JSON.parse(await sql(`SELECT coalesce(json_agg(row_to_json(r)),'[]') FROM (SELECT g.nba_game_id,g.status,p.nba_id,s.* FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id JOIN players p ON p.id=s.player_id WHERE g.game_date='${date}') r`))
  const fixtureGames = JSON.parse(await readFile(path.join(fixtureDirectory, 'games.json'), 'utf8')).games
  const games = fixtureGames.filter(game => game.date === date).map(game => game.id)
  let checked = 0, mutationDetected = false
  for (const game of games) {
    const box = await store.json(`boxscore-${game}`)
    const players = [...box.game.homeTeam.players, ...box.game.awayTeam.players]
    const actual = rows.filter(row => row.nba_game_id === game)
    assert.equal(actual.length, players.length, `${game}: complete final rows`)
    for (const player of players) {
      const row = actual.find(row => String(row.nba_id) === fixtureNbaId(game, player))
      assert.ok(row, `Missing final player: ${game}/${player.personId}`)
      assert.equal(row.status, 'Final')
      assertFinalPlayer(row, player)
      if (!mutationDetected) {
        assert.throws(() => assertFinalPlayer({ ...row, points: row.points + 1 }, player), /points/)
        mutationDetected = true
      }
      checked++
    }
  }
  assert.ok(checked > 0 && mutationDetected)
  const report = { date, games: games.length, players: checked, fieldsPerPlayer: Object.keys(fields).length + 4, mutationDetected, passed: true }
  await writeJson(path.join(miniRoot, `evidence/finals-${date}.json`), report)
  return report
}

export async function captureLoad(name, baseline = null) {
  assert.match(name, /^[a-z0-9-]+$/)
  const select = 'queryid::text,calls,total_exec_time,mean_exec_time,rows AS rows_returned_or_affected,shared_blks_hit,shared_blks_read,temp_blks_read,temp_blks_written,left(query,1200) AS query'
  const total = JSON.parse(await sql(`SELECT json_agg(r) FROM (SELECT ${select} FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 30) r`))
  const mean = JSON.parse(await sql(`SELECT json_agg(r) FROM (SELECT ${select} FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 30) r`))
  for (const row of [...total, ...mean]) if (/edge_internal_token|service_role_key|jwt_secret/i.test(row.query)) row.query = '[local credential configuration omitted]'
  const tables = JSON.parse(await sql("SELECT json_agg(r) FROM (SELECT schemaname,relname,seq_scan,seq_tup_read,idx_scan,idx_tup_fetch,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_user_tables ORDER BY seq_tup_read+idx_tup_fetch DESC) r"))
  if (baseline) for (const row of tables) {
    const before = baseline.find(entry => entry.schemaname === row.schemaname && entry.relname === row.relname)
    for (const key of ['seq_scan', 'seq_tup_read', 'idx_scan', 'idx_tup_fetch', 'n_tup_ins', 'n_tup_upd', 'n_tup_del']) row[key] = row[key] == null ? null : row[key] - (before?.[key] ?? 0)
  }
  await writeJson(path.join(miniRoot, `evidence/job-load-${name}.json`), { statementCountersResetAtRunStart: baseline != null, tableRowsRead: tables, byTotal: total, byMean: mean, exactRowsRead: null, rowsReadLimitation: 'pg_stat_statements exposes returned/affected rows and blocks, not tuples scanned.', edgeDurations: 'edge-invocations.jsonl' })
}

function rawPoints(player, settings) {
  if (player.played === '0') return 0
  const s = player.statistics
  const categories = ['points', 'reboundsTotal', 'assists', 'steals', 'blocks'].filter(key => s[key] >= 10).length
  let score = categories >= 2 ? settings.double_double ?? 0 : 0
  if (categories >= 3) score += settings.triple_double ?? 0
  for (const key of ['points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'three_pointers_made', 'field_goals_made', 'field_goals_attempted', 'free_throws_made', 'free_throws_attempted']) score += s[fields[key]] * (settings[key] ?? 0)
  return Math.sign(score) * Math.round(Math.abs(Number(score.toFixed(8))) * 100) / 100
}

export async function assertLeaguePoints(context) {
  assert.match(context.leagueId, /^[a-f0-9-]{36}$/)
  assert.match(context.leagueSeasonId, /^[a-f0-9-]{36}$/)
  assert.match(context.date, /^\d{4}-\d{2}-\d{2}$/)
  const label = name => `${name} league=${context.leagueId} season=${context.leagueSeasonId} date=${context.date}`
  const store = await fixtureStore(fixtureDirectory)
  const settings = await sqlJson(`SELECT scoring_settings FROM leagues WHERE id='${context.leagueId}'`, label('scoring settings'))
  const points = await sqlJson(`SELECT json_agg(r) FROM (SELECT v.fantasy_points,g.nba_game_id,p.nba_id,p.id AS player_id FROM v_fantasy_points v JOIN nba_games g ON g.id=v.game_id JOIN players p ON p.id=v.player_id WHERE v.league_id='${context.leagueId}' AND g.game_date='${context.date}') r`, label('player points'))
  assert.ok(Array.isArray(points) && points.length > 0, label('Fantasy points oracle must see real game rows'))
  const boxes = new Map()
  async function playerPoints(gameId, nbaId) {
    if (!boxes.has(gameId)) boxes.set(gameId, await store.json(`boxscore-${gameId}`))
    const game = boxes.get(gameId).game
    const player = [...game.homeTeam.players, ...game.awayTeam.players].find(player => fixtureNbaId(gameId, player) === String(nbaId))
    assert.ok(player)
    return rawPoints(player, settings)
  }
  for (const row of points) {
    const value = await playerPoints(row.nba_game_id, row.nba_id)
    assert.equal(row.fantasy_points, value, `Player fantasy points: ${row.nba_id}`)
  }
  const matchups = await sqlJson(`SELECT coalesce(json_agg(m),'[]') FROM matchups m WHERE league_season_id='${context.leagueSeasonId}' AND (SELECT week_number FROM season_weeks WHERE season_year=${context.seasonYear ?? season.year} AND '${context.date}' BETWEEN week_start AND week_end) BETWEEN week_number AND coalesce(end_week_number,week_number)`, label('matchups'))
  assert.ok(Array.isArray(matchups), label('Matchups must be an explicit JSON array'))
  if (!matchups.length) {
    const week = Number(await sql(`SELECT week_number FROM season_weeks WHERE season_year=${context.seasonYear ?? season.year} AND '${context.date}' BETWEEN week_start AND week_end`))
    assert.ok(week, 'Expected NBA calendar week must exist')
    const prior = await sqlJson(`SELECT json_build_object('finalizedAt',max(finalized_at),'finalized',bool_and(is_finalized),'now',extract(epoch FROM now())*1000) FROM matchups WHERE league_season_id='${context.leagueSeasonId}' AND NOT is_voided AND coalesce(end_week_number,week_number)<${week}`, label('boundary prerequisites'))
    checkBoundaryWait(prior)
  }
  const lineup = await sqlJson(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT l.member_id,l.week_number,l.slot_type,g.nba_game_id,p.nba_id FROM weekly_lineups l JOIN players p ON p.id=l.player_id JOIN player_game_stats s ON s.player_id=l.player_id JOIN nba_games g ON g.id=s.game_id AND g.game_date=l.game_date WHERE l.league_season_id='${context.leagueSeasonId}' AND l.slot_type::text NOT IN ('BE','IR')) r`, label('starter lineups'))
  assert.ok(Array.isArray(lineup), label('Starter lineups must be an explicit JSON array'))
  if (!lineup.length) assert.ok(context.plannedEmptyWeek === Number(await sql(`SELECT week_number FROM season_weeks WHERE season_year=${context.seasonYear ?? season.year} AND '${context.date}' BETWEEN week_start AND week_end`)), 'Empty starter coverage requires the planned empty week')
  for (const matchup of matchups ?? []) for (const side of ['home', 'away']) {
    let total = 0
    for (const row of lineup.filter(row => row.member_id === matchup[`${side}_member_id`] && row.week_number >= matchup.week_number && row.week_number <= (matchup.end_week_number ?? matchup.week_number))) total += await playerPoints(row.nba_game_id, row.nba_id)
    const rounded = Math.round(total * 100) / 100
    assert.equal(matchup[`${side}_points`], matchup.is_voided ? 0 : rounded, `${side} matchup points`)
  }
  const report = { leagueId: context.leagueId, date: context.date, playerGamePoints: points.length, matchups: matchups?.length ?? 0, starterGameRows: lineup.length, passed: true }
  await writeJson(path.join(miniRoot, `evidence/points-${context.date}.json`), report)
  return report
}

export async function resetLoad() {
  await sql('SELECT pg_stat_statements_reset()')
  return JSON.parse(await sql("SELECT coalesce(json_agg(r),'[]') FROM (SELECT schemaname,relname,seq_scan,seq_tup_read,idx_scan,idx_tup_fetch,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_user_tables) r"))
}

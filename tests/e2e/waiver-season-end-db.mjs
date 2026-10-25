import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { apiTarget, databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const db = databaseTarget().href
const api = apiTarget().origin
const project = process.env.PANCAKE_TEST_PROJECT_ID ?? 'pancake'
assert(/^[a-z0-9_-]+$/.test(project))
assert.equal(project, readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1], 'Internal worker target must match this checkout project')
const internal = `http://supabase_kong_${project}:8000`
const token = process.env.PANCAKE_EDGE_INTERNAL_TOKEN
assert(token)
const q = value => `'${String(value).replaceAll("'", "''")}'`
const sql = statement => {
  const result = spawnSync('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const json = statement => JSON.parse(sql(statement))
const edge = async (name, body = {}) => {
  const response = await fetch(`${api}/functions/v1/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-function-token': token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}
const log = (stage, data) => console.log(JSON.stringify({ provenance: 'SYNTHETIC', stage, ...data }))
const invocations = []
const keys = ['season-boundary', 'et-time:process-waivers']
const configuration = `SELECT set_config('app.supabase_url',${q(internal)},true); SELECT set_config('app.edge_internal_token',${q(token)},true);`
const wait = async (id) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const row = json(`SELECT row_to_json(i) FROM (SELECT worker_status,worker_finished_at,
      (SELECT status_code FROM net._http_response WHERE id=e.request_id) AS http,
      (SELECT content FROM net._http_response WHERE id=e.request_id) AS content,
      (SELECT error FROM sync_runs WHERE id=e.sync_run_id) AS error
      FROM edge_invocations e WHERE id=${id}) i`)
    if (row.worker_finished_at) return row
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Real queued worker does not finish: ${id}`)
}
const gate = async (name, dayOffset = 0, hour = name === 'process-waivers' ? 3 : 9) => {
  const before = Number(sql('SELECT COALESCE(max(id),0) FROM edge_invocations'))
  const when = `(((now() AT TIME ZONE 'America/New_York')::date+${dayOffset})::timestamp+interval '${hour} hours') AT TIME ZONE 'America/New_York'`
  const call = name === 'process-waivers'
    ? `SELECT invoke_edge_function_at_et_time('process-waivers',3,0,${when});`
    : `SELECT invoke_season_boundary_if_due(${when});`
  sql(`BEGIN; ${configuration} ${call} COMMIT;`)
  const id = Number(sql(`SELECT COALESCE(max(id),0) FROM edge_invocations WHERE id>${before} AND function_name=${q(name)}`))
  if (!id) return null
  invocations.push(id)
  const result = await wait(id)
  log(`gate:${name}`, { dayOffset, id, ...result })
  return { id, ...result }
}

for (const [index, mode] of ['faab', 'rolling'].entries()) {
  const league = randomUUID(), season = randomUUID(), year = 2193 + index * 2
  const users = [randomUUID(), randomUUID()], members = [randomUUID(), randomUUID()]
  const players = Array.from({ length: 6 }, () => randomUUID())
  const games = [randomUUID(), randomUUID()]
  log('fixture', { league, season, year, users, members, players, games })
  try {
    sql(`BEGIN;
      INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ${users.map(u => `(${q(u)},'authenticated','authenticated',${q(u+'@example.test')},'x',now(),'{}','{}',now(),now())`).join(',')};
      INSERT INTO leagues(id,name,slug,commissioner_id,status,waiver_mode,faab_starting_budget,weekly_add_limit,playoff_start_week,scoring_settings)
      VALUES(${q(league)},'Synthetic waiver boundary',${q(league)},${q(users[0])},'playoffs',${q(mode)},37,NULL,2,'{"points":1}');
      INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES
      (${q(members[0])},${q(league)},${q(users[0])},'commissioner','Winner'),
      (${q(members[1])},${q(league)},${q(users[1])},'manager','Runner');
      INSERT INTO league_seasons(id,league_id,season_year,is_current,playoff_start_week)
      VALUES(${q(season)},${q(league)},${year},true,2);
      INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority) VALUES
      (${q(league)},${q(season)},${q(members[0])},1),(${q(league)},${q(season)},${q(members[1])},2);
      INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES
      (${year},1,current_date-28,current_date-22),(${year},2,current_date-21,current_date-15);
      INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team)
      VALUES ${players.map((p,i) => `(${q(p)},'Synthetic',${q('Boundary '+i)},'PG',ARRAY['PG'],'Active','XWV')`).join(',')};
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at) VALUES
      ${members.map((m,i) => `(${q(league)},${q(season)},${q(m)},${q(players[i])},'draft',now()-interval '40 days')`).join(',')};
      INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
      VALUES ${games.map((g,i) => `(${q(g)},${q('002-waiver-'+g)},${year},${i+1},current_date-${27-i*7},now()-interval '${27-i*7} days','XWV','XWX','Final',now())`).join(',')};
      INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play)
      VALUES ${games.flatMap((g,w) => members.map((m,i) => `(${q(players[i])},${q(g)},${year},${w+1},current_date-${27-w*7},${i===0?40:10},false)`)).join(',')};
      INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set)
      VALUES ${games.flatMap((g,w) => members.map((m,i) => `(${q(league)},${q(season)},${q(m)},${q(players[i])},${w+1},current_date-${27-w*7},'PG',false)`)).join(',')};
      INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,
        home_points,away_points,winner_member_id,is_finalized,finalized_at)
      VALUES ${['regular_season','playoff_final'].map((type,i) => `(${q(league)},${q(season)},${i+1},${q(members[0])},${q(members[1])},${q(type)},40,10,${q(members[0])},true,now()-interval '73 hours')`).join(',')};
      SELECT set_config('request.jwt.claim.sub',${q(users[0])},true);
      SELECT add_free_agent_atomic(${q(members[0])},${q(league)},${q(players[2])});
      SELECT add_free_agent_atomic(${q(members[0])},${q(league)},${q(players[3])});
      SELECT drop_player_atomic(id) FROM roster_players WHERE league_season_id=${q(season)} AND player_id IN(${q(players[2])},${q(players[3])});
      SELECT commissioner_adjust_faab_balance_atomic(${q(league)},${q(members[1])},25);
      SELECT create_waiver_claim_atomic(${q(league)},${q(members[1])},${q(players[2])},NULL,${q(users[1])},11);
      DELETE FROM cron_dispatch_state WHERE job_key IN(${keys.map(q).join(',')});
      COMMIT;`)
    let claim = sql(`SELECT id FROM waiver_claims WHERE league_season_id=${q(season)} AND status='pending'`)
    await edge('sync-scores', { leagueId: league, date: new Date().toISOString() })
    sql(`UPDATE matchups SET finalized_at=now()-interval '73 hours' WHERE league_season_id=${q(season)}`)
    await edge('sync-scores', { leagueId: league, date: new Date().toISOString() })
    const final = json(`SELECT row_to_json(m) FROM (SELECT home_points,away_points,winner_member_id,finalized_at FROM matchups WHERE league_season_id=${q(season)} AND matchup_type='playoff_final') m`)
    log('scored-final', final)
    assert.equal(final.winner_member_id, members[0], 'Real scorer preserves synthetic final winner')
    assert(Date.parse(final.finalized_at) < Date.now()-48*3600000, 'Real final grace has elapsed')
    assert.equal(sql(`SELECT bool_and(clears_at=placed_on_waivers_at+interval '48 hours') FROM waiver_wire_log WHERE league_season_id=${q(season)}`), 't')
    assert.equal(await gate('process-waivers', 0, 2), null, 'Waiver cron refuses an early tick')
    const fresh = await gate('process-waivers')
    assert.equal(fresh.worker_status, 'success')
    assert.equal(sql(`SELECT status FROM waiver_claims WHERE id=${q(claim)}`), 'pending')
    const blocked = await gate('season-boundary')
    assert.equal(blocked.worker_status, 'failed', 'A pending claim/hold delays the real automatic boundary')
    assert.match(blocked.error, /pending waiver claims and waiver holds/)
    assert.equal(sql(`SELECT count(*) FROM league_seasons WHERE league_id=${q(league)}`), '1')
    sql(`UPDATE edge_invocations SET queued_at=now()-interval '2 minutes' WHERE id=${blocked.id}; SELECT private.reconcile_edge_invocations();`)
    assert.equal(sql("SELECT retry_after>now() FROM cron_dispatch_state WHERE job_key='season-boundary'"), 't', 'Real reconciliation schedules a retry')
    assert.equal(await gate('season-boundary'), null, 'Retry waits for backoff')
    sql(`SELECT cancel_waiver_claim_atomic(${q(claim)},${q(members[1])},${q(users[1])});
      UPDATE cron_dispatch_state SET retry_after=now()-interval '1 second' WHERE job_key='season-boundary';`)
    const holdOnly = await gate('season-boundary')
    assert.equal(holdOnly.worker_status, 'failed', 'An unclaimed drop hold also delays rollover')
    assert.match(holdOnly.error, /waiver holds/)
    assert.equal(sql(`SELECT count(*) FROM league_seasons WHERE league_id=${q(league)}`), '1')
    if (mode === 'faab') {
      claim = sql(`SELECT create_waiver_claim_atomic(${q(league)},${q(members[1])},${q(players[2])},NULL,${q(users[1])},11)`)
    } else {
      sql(`BEGIN; SELECT set_config('request.jwt.claim.sub',${q(users[0])},true);
        SELECT add_free_agent_atomic(${q(members[0])},${q(league)},${q(players[5])});
        SELECT drop_player_atomic(id) FROM roster_players WHERE league_season_id=${q(season)} AND player_id=${q(players[5])}; COMMIT;`)
    }
    sql(`UPDATE waiver_wire_log SET placed_on_waivers_at=now()-interval '49 hours',clears_at=now()-interval '1 hour' WHERE league_season_id=${q(season)};
      UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date WHERE league_season_id=${q(season)};`)
    const cleared = await gate('process-waivers', 1)
    assert.equal(cleared.worker_status, 'success')
    assert.equal(sql(`SELECT status FROM waiver_claims WHERE id=${q(claim)}`), mode==='faab'?'succeeded':'cancelled', 'Playoff claim is settled through the real path')
    assert.equal(sql(`SELECT count(*) FROM waiver_wire_log WHERE league_season_id=${q(season)} AND cleared_at IS NULL`), '0', 'Unclaimed hold expires too')
    assert.equal(json(`SELECT to_json(finalized_at) FROM matchups WHERE league_season_id=${q(season)} AND matchup_type='playoff_final'`), final.finalized_at, 'Waiver refresh preserves the final grace timestamp')
    assert.equal(sql(`SELECT balance FROM faab_balances WHERE league_season_id=${q(season)} AND member_id=${q(members[1])}`), mode==='faab'?'14':'25')
    sql("UPDATE cron_dispatch_state SET retry_after=now()-interval '1 second' WHERE job_key='season-boundary'")
    const rolled = await gate('season-boundary')
    assert.equal(rolled.worker_status, 'success')
    const next = sql(`SELECT id FROM league_seasons WHERE league_id=${q(league)} AND is_current`)
    if (next === season) {
      const followingDay = await gate('season-boundary', 1)
      const liveWork = Number(sql('SELECT count(*) FROM get_live_poll_work()'))
      const beforeLive = sql('SELECT COALESCE(max(id),0) FROM edge_invocations')
      sql(`BEGIN; ${configuration} SELECT invoke_live_poll_if_due(); COMMIT;`)
      assert.equal(sql('SELECT COALESCE(max(id),0) FROM edge_invocations'), beforeLive, 'No NBA work can dispatch a score refresh')
      log('rollover-stall', { mode, season, next, liveWork, followingDay,
        certificatesCurrent: sql(`SELECT bool_and(input_token=private.score_input_token(league_season_id,week_number)) FROM private.score_week_certificates WHERE league_season_id=${q(season)}`)==='t' })
    }
    assert.notEqual(next, season, 'Automatic boundary eventually rolls over after mature waivers clear')
    assert.equal(sql(`SELECT count(*) FROM league_seasons WHERE league_id=${q(league)}`), '2')
    assert.deepEqual(json(`SELECT json_agg(member_id ORDER BY priority) FROM waiver_priorities WHERE league_season_id=${q(next)}`), [members[1],members[0]], 'Actual rollover uses reverse standings')
    assert.deepEqual(json(`SELECT json_agg(balance ORDER BY member_id) FROM faab_balances WHERE league_season_id=${q(next)}`), [37,37], 'Actual rollover seeds the configured budget')
    assert.equal(sql(`SELECT balance FROM faab_balances WHERE league_season_id=${q(season)} AND member_id=${q(members[1])}`), mode==='faab'?'14':'25', 'Rollover preserves old balance history')
    sql(`BEGIN; SELECT set_config('request.jwt.claim.sub',${q(users[0])},true);
      SELECT add_free_agent_atomic(${q(members[0])},${q(league)},${q(players[4])});
      SELECT drop_player_atomic(id) FROM roster_players WHERE league_season_id=${q(next)} AND player_id=${q(players[4])};
      SELECT create_waiver_claim_atomic(${q(league)},${q(members[1])},${q(players[4])},NULL,${q(users[1])},5);
      UPDATE waiver_wire_log SET clears_at=now()-interval '1 second' WHERE league_season_id=${q(next)};
      UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date WHERE league_season_id=${q(next)}; COMMIT;`)
    const offseason = await gate('process-waivers', 2)
    assert.equal(offseason.worker_status, 'success')
    assert.equal(sql(`SELECT status FROM waiver_claims WHERE league_season_id=${q(next)}`), 'succeeded', 'Offseason claims process too')
    const balance = mode==='faab'?'32':'37'
    assert.equal(sql(`SELECT balance FROM faab_balances WHERE league_season_id=${q(next)} AND member_id=${q(members[1])}`), balance)
    const order = json(`SELECT json_agg(member_id ORDER BY priority) FROM waiver_priorities WHERE league_season_id=${q(next)}`)
    assert.deepEqual(order, [members[0],members[1]], 'Offseason winner moves last in the new season')
    const repeated = await gate('season-boundary', 1)
    assert.equal(repeated.worker_status, 'success')
    assert.equal(sql(`SELECT count(*) FROM league_seasons WHERE league_id=${q(league)}`), '2', 'Next daily boundary does not roll twice')
    assert.equal(sql(`SELECT balance FROM faab_balances WHERE league_season_id=${q(next)} AND member_id=${q(members[1])}`), balance, 'Next boundary does not replenish spent FAAB')
    assert.deepEqual(json(`SELECT json_agg(member_id ORDER BY priority) FROM waiver_priorities WHERE league_season_id=${q(next)}`), order, 'Next boundary does not reset changed priority')
    log('season-end-complete', { mode, delayed: true, retried: true, seasons: 2, newBudget: 37, nextBalance: balance })
  } finally {
    sql(`DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM player_game_stats WHERE game_id IN(${games.map(q).join(',')});
      DELETE FROM nba_games WHERE id IN(${games.map(q).join(',')});
      DELETE FROM players WHERE id IN(${players.map(q).join(',')});
      DELETE FROM auth.users WHERE id IN(${users.map(q).join(',')});
      DELETE FROM season_weeks WHERE season_year IN(${year},${year+1});
      DELETE FROM cron_dispatch_state WHERE job_key IN(${keys.map(q).join(',')});`)
  }
}
log('complete', { queuedRealWorkers: invocations.length })

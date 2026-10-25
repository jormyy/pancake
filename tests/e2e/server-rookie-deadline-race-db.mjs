import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const run = promisify(execFile)
const sql = statement => execFileSync('psql', [db, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim()
const users = [randomUUID(), randomUUID()]
const members = [randomUUID(), randomUUID()]
const players = Array.from({ length: 4 }, () => randomUUID())
const rosters = Array.from({ length: 4 }, () => randomUUID())
const league = randomUUID(), season = randomUUID(), draft = randomUUID(), game = randomUUID()
const prefix = `rookie-deadline-${randomUUID()}`
const operations = []
const start = (name, statement) => {
  const operation = run('psql', [db, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    encoding: 'utf8', env: { ...process.env, PGAPPNAME: `${prefix}-${name}` },
  }).then(value => ({ ok: true, value }), error => ({ ok: false, error }))
  operations.push(operation)
  return operation
}
try {
  sql(`BEGIN;
    INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
      ('${users[0]}','${users[0]}@example.test','{}'),('${users[1]}','${users[1]}@example.test','{}');
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
      VALUES('${league}','Rookie deadline race','${league}','${users[0]}','drafting',1,1,1);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',9850,true);
    INSERT INTO league_members(id,league_id,user_id,role) VALUES
      ('${members[0]}','${league}','${users[0]}','commissioner'),('${members[1]}','${league}','${users[1]}','manager');
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES('${game}','002${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}',9850,1,
        (now() AT TIME ZONE 'America/New_York')::date-1,'RDA','RDB','Scheduled');
    INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
      VALUES('${draft}','${league}','${season}','snake','in_progress',false,1);
    ${players.map((player, index) => `INSERT INTO players(id,first_name,last_name,years_exp,nba_draft_number,injury_status)
      VALUES('${player}','Race','${index}',${index % 2 ? 0 : 3},1,'Out');
      INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES('${rosters[index]}','${league}','${season}','${members[Math.floor(index / 2)]}','${player}','draft');`).join('\n')}
    INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,player_id,picked_at) VALUES
      ('${draft}',1,1,1,'${members[0]}','${players[1]}',now()),
      ('${draft}',2,1,2,'${members[1]}','${players[3]}',now());
    COMMIT;`)
  const completion = start('completion', `BEGIN; SET LOCAL statement_timeout='12s';
    SELECT 1 FROM leagues WHERE id='${league}' FOR UPDATE;
    SELECT pg_sleep(5);
    SELECT private.complete_rookie_draft_if_ready('${draft}'); COMMIT;`)
  const until = Date.now() + 4000
  while (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${prefix}-completion' AND wait_event='PgSleep'`) !== '1') {
    assert(Date.now() < until, 'completion must hold its real league lock')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const manager = start('manager', `BEGIN; SET LOCAL statement_timeout='12s';
    SELECT public.toggle_ir_atomic('${rosters[3]}',true,'${users[1]}'); COMMIT;`)
  let blocked = false
  while (Date.now() < until) {
    blocked = sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_stat_activity b
      ON a.pid=ANY(pg_blocking_pids(b.pid)) WHERE a.application_name='${prefix}-completion'
        AND b.application_name='${prefix}-manager')`) === 't'
    if (blocked) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(blocked, 'the actual roster move must wait on draft completion before the race proceeds')
  const results = await Promise.all([completion, manager])
  assert(results.every(result => result.ok), results.flatMap(result => 'error' in result ? [result.error?.stderr] : []).join('\n'))
  assert.equal(sql(`SELECT status FROM leagues WHERE id='${league}'`), 'active')
  assert.equal(sql(`SELECT is_on_taxi FROM roster_players WHERE id='${rosters[1]}'`), 't')
  assert.equal(sql(`SELECT is_on_ir AND NOT is_on_taxi FROM roster_players WHERE id='${rosters[3]}'`), 't')
  console.log('PASS: deadline completion and a waiting manager move both commit without a deadlock')
} finally {
  await Promise.all(operations)
  sql(`DELETE FROM drafts WHERE id='${draft}'; DELETE FROM leagues WHERE id='${league}'; DELETE FROM nba_games WHERE id='${game}';
    DELETE FROM players WHERE id IN (${players.map(id => `'${id}'`).join(',')});
    DELETE FROM auth.users WHERE id IN ('${users[0]}','${users[1]}');`)
}

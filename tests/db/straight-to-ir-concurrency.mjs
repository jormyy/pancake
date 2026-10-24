import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Use a local database')
const run = promisify(execFile)
const sql = (text) => execFileSync('psql', [url, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', text], { encoding: 'utf8' }).trim()
const [user, league, member, season, first, second] = Array.from({ length: 6 }, () => randomUUID())
try {
  sql(`BEGIN;
    INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${user}','${user}@example.test','{}');
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots) VALUES('${league}','IR race','${league}','${user}','active',1,1);
    INSERT INTO league_members(id,league_id,user_id,role) VALUES('${member}','${league}','${user}','commissioner');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',public.current_season_year_et(),true);
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,injury_status) VALUES
    ('${first}','First','Race','PG',ARRAY['PG'],'Out'),('${second}','Second','Race','PG',ARRAY['PG'],'IR');
    COMMIT;`)
  const results = await Promise.allSettled([first, second].map((player, index) => run('psql', [url, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', `
    BEGIN;
    SET LOCAL statement_timeout='10s';
    SELECT set_config('request.jwt.claim.sub','${user}',true);
    ${index === 0 ? `SELECT pg_advisory_xact_lock(hashtext('${league}'),hashtext('${member}')); SELECT pg_sleep(0.3);` : ''}
    SELECT add_free_agent_atomic('${member}','${league}','${player}',true);
    COMMIT;`], { encoding: 'utf8' })))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const failure = results.find((result) => result.status === 'rejected')
  assert.match(failure.reason.stderr, /Your IR slots are full/)
  assert.equal(sql(`SELECT count(*) FROM roster_players WHERE member_id='${member}' AND is_on_ir AND NOT is_on_taxi`), '1')
  assert.equal(sql(`SELECT sum(add_count) FROM weekly_add_counts WHERE member_id='${member}'`), '1')
  console.log('PASS: concurrent adds award exactly one IR slot and one weekly add')
} finally {
  sql(`DELETE FROM leagues WHERE id='${league}'; DELETE FROM players WHERE id IN ('${first}','${second}'); DELETE FROM auth.users WHERE id='${user}';`)
}

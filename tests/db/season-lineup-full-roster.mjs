import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { databaseTarget, apiTarget } from '../../scripts/mutation/waivers/targets.mjs'

const db = databaseTarget().href
const api = apiTarget().origin
const sql = value => execFileSync('psql', [db, '-X', '-At', '-v', 'ON_ERROR_STOP=1'], { input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const owner = randomUUID(), league = randomUUID(), season = randomUUID(), member = randomUUID()
const prefix = randomUUID()
const days = 180
let setup = false
try {
  sql(`BEGIN;
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('${owner}','authenticated','authenticated','${owner}@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size) VALUES('${league}','Full season optimizer','${league}','${owner}','active',20);
INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',2130,true);
INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES('${member}','${league}','${owner}','commissioner','Full roster');
INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
SELECT 2130,n,(now() AT TIME ZONE 'America/New_York')::date+1+(n-1)*7,(now() AT TIME ZONE 'America/New_York')::date+n*7 FROM generate_series(1,26) n;
WITH added AS (INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,years_exp)
SELECT md5('${prefix}'||n)::uuid,'Season',n::text,'Q'||lpad(n::text,2,'0'),(ARRAY['PG','SG','SF','PF','C'])[1+(n-1)%5]::nba_position,ARRAY[(ARRAY['PG','SG','SF','PF','C'])[1+(n-1)%5]],5 FROM generate_series(1,20) n RETURNING id)
INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) SELECT '${league}','${season}','${member}',id,'draft' FROM added;
INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
SELECT md5('${prefix}'||d||':'||n)::uuid,'002-${prefix}-'||d||'-'||n,2130,1+(d-1)/7,(now() AT TIME ZONE 'America/New_York')::date+d,'Q'||lpad((n*2-1)::text,2,'0'),'Q'||lpad((n*2)::text,2,'0'),'Scheduled',now()+make_interval(days=>d) FROM generate_series(1,${days}) d CROSS JOIN generate_series(1,10) n;
COMMIT;`)
  setup = true
  const started = performance.now()
  const response = await fetch(`${api}/functions/v1/lineup-optimizer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-function-token': 'review-local-only' },
    body: JSON.stringify({ mode: 'rest_of_season', leagueId: league, leagueSeasonId: season, memberId: member }),
    signal: AbortSignal.timeout(30_000),
  })
  const result = await response.json()
  const elapsedMs = Math.round(performance.now() - started)
  console.log(JSON.stringify({ status: response.status, elapsedMs, dates: result.dates, optimized: result.optimized, failed: result.failed }))
  assert.equal(response.status, 200)
  assert.equal(result.failed, 0)
  assert.equal(result.optimized, days)
  assert.equal(Number(sql(`SELECT count(DISTINCT game_date) FROM weekly_lineups WHERE league_id='${league}'`)), days)
  assert.equal(Number(sql(`SELECT count(*) FROM weekly_lineups WHERE league_id='${league}'`)), days * 10)
} finally {
  if (setup) sql(`BEGIN;
DELETE FROM weekly_lineups WHERE league_id='${league}';
DELETE FROM leagues WHERE id='${league}';
DELETE FROM players WHERE id IN (SELECT md5('${prefix}'||n)::uuid FROM generate_series(1,20) n);
DELETE FROM nba_games WHERE nba_game_id LIKE '002-${prefix}-%';
DELETE FROM season_weeks WHERE season_year=2130;
DELETE FROM auth.users WHERE id='${owner}';
COMMIT;`)
}

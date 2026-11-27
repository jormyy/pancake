#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { requireLocal } from './run.mjs'

const dir = path.resolve(process.argv[2] ?? '')
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.ok(run.readyAt && !run.cleanedAt)
requireLocal(run.url)
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(env.SUPABASE_DB_URL).hostname))
const state = JSON.parse(await readFile(path.join(run.work, 'tests/e2e-state.json'), 'utf8'))
const [alpha, beta] = state.users
const label = `Rookie Rehearsal ${Date.now().toString(36)}`
const q = value => `'${String(value).replaceAll("'", "''")}'`

const sql = `
BEGIN;
CREATE TEMP TABLE ids ON COMMIT DROP AS SELECT
  gen_random_uuid() AS league, gen_random_uuid() AS alpha, gen_random_uuid() AS beta,
  gen_random_uuid() AS last_season, gen_random_uuid() AS season, public.current_season_year_et() AS year;
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots,rookie_draft_order,team_limit)
  SELECT league, ${q(label)}, lower(replace(${q(label)},' ','-')), ${q(alpha.id)}::uuid, 'offseason', 6, 0, 1, 'linear', 2 FROM ids;
INSERT INTO league_members(id,league_id,user_id,role,team_name,joined_at)
  SELECT alpha, league, ${q(alpha.id)}::uuid, 'commissioner'::league_member_role, 'Alpha', now() - interval '2 minutes' FROM ids
  UNION ALL SELECT beta, league, ${q(beta.id)}::uuid, 'manager'::league_member_role, 'Beta', now() - interval '1 minute' FROM ids;
INSERT INTO league_seasons(id,league_id,season_year,is_current)
  SELECT last_season, league, year - 1, false FROM ids UNION ALL SELECT season, league, year, true FROM ids;
INSERT INTO standings(league_id,league_season_id,member_id,week_number,wins,losses,ties,points_for,points_against)
  SELECT league, last_season, alpha, 20, 14, 6, 0, 2400, 2100 FROM ids
  UNION ALL SELECT league, last_season, beta, 20, 6, 14, 0, 2100, 2400 FROM ids;
INSERT INTO players(sportsdata_id,first_name,last_name,position,eligible_positions,nba_team,status,years_exp,career_regular_season_games)
  SELECT 'rehearsal-' || tag || '-' || ids.league, 'Rehearsal', name, 'SF'::nba_position, ARRAY['SF'], 'BOS', 'Active', exp, games
    FROM ids, (VALUES ('a1','Vet A1',6,400),('a2','Vet A2',6,400),('a3','Vet A3',6,400),('a4','Vet A4',6,400),('a5','Vet A5',6,400),('a6','Vet A6',6,400),
                      ('ataxi','Taxi A',1,10),('b1','Vet B1',6,400),('b2','Vet B2',6,400),('b3','Vet B3',6,400)) AS v(tag,name,exp,games);
INSERT INTO players(sportsdata_id,nba_id,first_name,last_name,position,eligible_positions,nba_team,status,years_exp,nba_draft_number,draft_status,draft_year,draft_round,draft_overall_pick)
  SELECT 'rehearsal-' || tag || '-' || ids.league, nba, 'Decoy', name, 'PG'::nba_position, ARRAY['PG'], 'BOS', 'Active', 0, number, status, dyear, CASE WHEN status = 'drafted' THEN 1 END, overall
    FROM ids, (VALUES ('undrafted','Undrafted', 'REH-UND-', 31, 'undrafted', NULL, NULL),
                      ('wrongyear','Wrong Year', 'REH-WY-', 32, 'drafted', -2, 12),
                      ('duplicate','Duplicate Pick', 'REH-DUP-', 5, 'drafted', -1, 5),
                      ('noid','No NBA Id', NULL, 33, 'drafted', -1, 33)) AS v(tag,name,nbaprefix,number,status,yearoffset,overall)
    CROSS JOIN LATERAL (SELECT CASE WHEN nbaprefix IS NULL THEN NULL ELSE nbaprefix || left(ids.league::text, 8) END AS nba,
                               CASE WHEN yearoffset IS NULL THEN NULL ELSE ids.year + yearoffset END AS dyear) AS derived;
INSERT INTO private.taxi_acquisition_context(transaction_id,league_id,league_season_id,member_id,player_id,source,related_id)
  SELECT pg_current_xact_id(), ids.league, ids.season, ids.alpha, p.id, 'draft', ids.season
    FROM ids JOIN players p ON p.sportsdata_id = 'rehearsal-ataxi-' || ids.league;
INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi,taxi_start_season_year)
  SELECT ids.league, ids.season, CASE WHEN p.last_name LIKE '% A%' THEN ids.alpha ELSE ids.beta END, p.id, 'draft',
         p.last_name = 'Taxi A', CASE WHEN p.last_name = 'Taxi A' THEN ids.year END
    FROM ids JOIN players p ON p.sportsdata_id LIKE 'rehearsal-%-' || ids.league AND p.first_name = 'Rehearsal';
INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  SELECT ids.league, ids.season, ids.beta, p.id, 'draft' FROM ids, players p WHERE p.sportsdata_id = 'e2e-player-010';
INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT ids.league, ids.year - 1, r, m, CASE WHEN m = ids.alpha AND r = 3 THEN ids.beta ELSE m END
    FROM ids, generate_series(1,3) r, unnest(ARRAY[ids.alpha, ids.beta]) m;
INSERT INTO draft_pick_swaps(league_id,season_year,round,holder_member_id,counterparty_member_id)
  SELECT league, year - 1, 1, alpha, beta FROM ids UNION ALL SELECT league, year - 1, 2, beta, alpha FROM ids;
SELECT json_build_object('label', ${q(label)}, 'leagueId', league, 'seasonId', season, 'seasonYear', year, 'classYear', year - 1,
  'alpha', json_build_object('userIndex', 0, 'memberId', alpha, 'team', 'Alpha'),
  'beta', json_build_object('userIndex', 1, 'memberId', beta, 'team', 'Beta'),
  'limits', json_build_object('active', 6, 'taxi', 1),
  'decoys', (SELECT json_agg(display_name ORDER BY display_name) FROM players WHERE sportsdata_id LIKE 'rehearsal-%-' || ids.league AND first_name = 'Decoy'),
  'unavailable', (SELECT display_name FROM players WHERE sportsdata_id = 'e2e-player-010'))::text FROM ids;
COMMIT;`

const output = execFileSync('psql', [env.SUPABASE_DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }).trim()
const fixture = JSON.parse(output.split('\n').at(-1))
await writeFile(path.join(dir, 'rookie-draft-fixture.json'), JSON.stringify(fixture, null, 2) + '\n')
console.log(JSON.stringify(fixture, null, 2))

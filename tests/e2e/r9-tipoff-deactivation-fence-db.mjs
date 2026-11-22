import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const target = new URL(process.env.SUPABASE_DB_URL)
assert.equal(target.hostname, '127.0.0.1')
assert.equal(target.port, process.env.PANCAKE_TEST_DB_PORT ?? '54322')
const db = target.href
const quote = value => "'" + String(value).replaceAll("'", "''") + "'"
const run = (statement, options = {}) => new Promise((resolve, reject) => {
  execFile('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    env: { ...process.env, PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=15000' },
    ...options,
  }, (error, stdout, stderr) => error ? reject(new Error(`${stderr || error.message}\nSQL: ${statement}`)) : resolve(stdout.trim()))
})
const runFile = (file, options = {}) => new Promise((resolve, reject) => {
  execFile('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', file], {
    env: { ...process.env, PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=15000' },
    ...options,
  }, (error, stdout, stderr) => error ? reject(new Error(`${stderr || error.message}\nFILE: ${file}`)) : resolve(stdout.trim()))
})
const json = async statement => JSON.parse(await run(statement))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ids = Object.fromEntries(['league', 'season', 'user', 'member', 'other', 'player', 'injured', 'game', 'dispatch', 'shared'].map(key => [key, randomUUID()]))
const token = randomUUID()
const sharedToken = randomUUID()
const year = 9802
const today = await run("SELECT (now() AT TIME ZONE 'America/New_York')::date")
const tipoff = await run(`SELECT now() + interval '10 minutes'`)
const marker = path.join(await mkdtemp(path.join(os.tmpdir(), 'pancake-r9-')), 'fence.marker')

const cleanup = async () => {
  await run(`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at = ${quote(tipoff)};
    DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${quote(tipoff)};
    DELETE FROM public.leagues WHERE id = ${quote(ids.league)};
    DELETE FROM public.nba_games WHERE nba_game_id = '002r9fence';
    DELETE FROM public.players WHERE id = ANY(ARRAY[${quote(ids.player)},${quote(ids.injured)}]::uuid[]);
    DELETE FROM auth.users WHERE id = ANY(ARRAY[${quote(ids.user)},${quote(ids.other)}]::uuid[]);`)
  await rm(path.dirname(marker), { recursive: true, force: true })
}

await run(`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at = ${quote(tipoff)};
  DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${quote(tipoff)};
  DELETE FROM public.nba_games WHERE nba_game_id = '002r9fence'`)

try {
  await run(`BEGIN;
    INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
      (${quote(ids.user)}, ${quote(ids.user + '@example.test')}, jsonb_build_object('username', ${quote(ids.user)})),
      (${quote(ids.other)}, ${quote(ids.other + '@example.test')}, jsonb_build_object('username', ${quote(ids.other)}));
    INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, ir_slots, scoring_settings)
      VALUES(${quote(ids.league)}, 'R9 fence', ${quote(ids.league)}, ${quote(ids.user)}, 'active', 20, 1, '{"points":1}');
    INSERT INTO public.league_members(id, league_id, user_id, role, team_name) VALUES
      (${quote(ids.member)}, ${quote(ids.league)}, ${quote(ids.user)}, 'commissioner', 'Fence team'),
      (${quote(ids.other)}, ${quote(ids.league)}, ${quote(ids.other)}, 'manager', 'Other team');
    INSERT INTO public.league_seasons(id, league_id, season_year, is_current)
      VALUES(${quote(ids.season)}, ${quote(ids.league)}, ${year}, true);
    INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
      VALUES(${year}, 1, ${quote(today)}::date - 6, ${quote(today)}::date)
      ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end = EXCLUDED.week_end;
    INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members)
      VALUES(${quote(ids.league)}, true);
    SELECT private.activate_league_roster_policy(${quote(ids.league)});
    INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
      VALUES(${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, true, now())
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled = true, enabled_at = now();
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
      VALUES(${quote(ids.player)}, 'Healthy', 'Fixture', 'PG', ARRAY['PG'], NULL, 'unknown', 'AAA'),
        (${quote(ids.injured)}, 'Injured', 'Fixture', 'PG', ARRAY['PG'], 'Out', (${quote(today)}::date + 14)::text, 'AAA');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES(${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, ${quote(ids.player)}, 'draft'),
        (${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, ${quote(ids.injured)}, 'draft');
    INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
      VALUES(${quote(ids.game)}, '002r9fence', ${year}, 1, ${quote(today)}, ${quote(tipoff)}, 'AAA', 'BBB', 'Scheduled');
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
      VALUES(${quote(tipoff)}, ${quote(ids.league)}, ${quote(today)}, ${quote(token)}, 'running', now() + interval '5 minutes'),
        (${quote(tipoff)}, '', ${quote(today)}, ${quote(sharedToken)}, 'running', now() + interval '5 minutes');
  COMMIT;`)

  const assignments = `jsonb_build_array(jsonb_build_object('player_id', ${quote(ids.player)}, 'slot_type', 'PG', 'is_auto_set', true, 'week_number', 1, 'expected_active', true))`
  const apply = `SELECT public.apply_pre_tipoff_lineup(${quote(tipoff)}, ${quote(token)}, ${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, ${assignments}, ${quote(ids.league)})`
  const sessionA = path.join(path.dirname(marker), 'session-a.sql')
  await writeFile(sessionA, `BEGIN;\n${apply};\n\\! touch ${marker}\nSELECT pg_sleep(3);\nCOMMIT;\n`)

  const holder = runFile(sessionA)
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await access(marker); break } catch { await sleep(50) }
  }
  await access(marker)

  const started = performance.now()
  await run(`UPDATE private.league_roster_policies SET ir_activated_at = NULL, floor_activated_at = NULL WHERE league_id = ${quote(ids.league)}`)
  const waited = performance.now() - started
  await holder
  assert.ok(waited >= 2000, `The deactivation did not wait for the in-flight scoped effect: ${Math.round(waited)}ms`)

  const refused = await run(`SELECT public.auto_manage_ir_tipoff_service(${quote(tipoff)}, ${quote(token)}, ${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, ${quote(ids.league)})`)
    .then(() => 'accepted', error => error.message.includes('Tipoff scope is no longer active.') ? 'refused' : `unexpected: ${error.message}`)
  assert.equal(refused, 'refused', 'A scoped effect started after deactivation was not refused')
  assert.equal(await run(`SELECT count(*) FROM public.roster_players WHERE league_id = ${quote(ids.league)} AND member_id = ${quote(ids.member)} AND player_id = ${quote(ids.injured)} AND is_on_ir`), '0',
    'The refused scoped effect changed IR state')

  await run(`UPDATE private.league_roster_policies SET ir_activated_at = now(), floor_activated_at = now() WHERE league_id = ${quote(ids.league)}`)
  const sharedPending = await json(`SELECT COALESCE(jsonb_agg(row_to_json(m)), '[]') FROM public.get_pending_tipoff_members(${quote(tipoff)}, ${quote(sharedToken)}, ARRAY[]::uuid[], 100, '') m WHERE m.league_id = ${quote(ids.league)}`)
  assert.equal(sharedPending.length, 0, 'The reactivated league remained in the shared selection')
  const sharedApply = await run(`SELECT public.apply_pre_tipoff_lineup(${quote(tipoff)}, ${quote(sharedToken)}, ${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, ${assignments}, '')`)
  assert.equal(sharedApply, 'f', 'The shared apply did not skip the reactivated league')
  const sharedAgain = await json(`SELECT COALESCE(jsonb_agg(row_to_json(m)), '[]') FROM public.get_pending_tipoff_members(${quote(tipoff)}, ${quote(sharedToken)}, ARRAY[]::uuid[], 100, '') m WHERE m.league_id = ${quote(ids.league)}`)
  assert.equal(sharedAgain.length, 0, 'The skipped shared member spun back into the selection')

  console.log(JSON.stringify({ waitedMs: Math.round(waited), refused, sharedPending: sharedPending.length, sharedApply, sharedAgain: sharedAgain.length }))
} finally {
  await cleanup()
}

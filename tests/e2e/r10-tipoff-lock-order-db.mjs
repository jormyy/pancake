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
const run = statement => new Promise((resolve, reject) => {
  execFile('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    env: { ...process.env, PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=15000' },
  }, (error, stdout, stderr) => error ? reject(new Error(`${stderr || error.message}\nSQL: ${statement}`)) : resolve(stdout.trim()))
})
const runFile = file => new Promise(resolve => {
  execFile('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', file], {
    env: { ...process.env, PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=15000' },
  }, (error, stdout, stderr) => resolve({ ok: !error, stderr: stderr ?? '', stdout: stdout ?? '' }))
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ids = Object.fromEntries(['league', 'season', 'user', 'member', 'player', 'game', 'dispatch'].map(key => [key, randomUUID()]))
const token = randomUUID()
const year = 9803
const today = await run("SELECT (now() AT TIME ZONE 'America/New_York')::date")
const tipoff = await run(`SELECT now() + interval '10 minutes'`)
const dir = await mkdtemp(path.join(os.tmpdir(), 'pancake-r10-lock-'))
const marker = name => path.join(dir, name)

const cleanup = async () => {
  await run(`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at = ${quote(tipoff)};
    DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${quote(tipoff)};
    DELETE FROM public.leagues WHERE id = ${quote(ids.league)};
    DELETE FROM public.nba_games WHERE nba_game_id = '002r10lock';
    DELETE FROM public.players WHERE id = ${quote(ids.player)};
    DELETE FROM auth.users WHERE id = ${quote(ids.user)};`)
  await rm(dir, { recursive: true, force: true })
}

await run(`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at = ${quote(tipoff)};
  DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${quote(tipoff)};
  DELETE FROM public.nba_games WHERE nba_game_id = '002r10lock'`)

try {
  await run(`BEGIN;
    INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
      (${quote(ids.user)}, ${quote(ids.user + '@example.test')}, jsonb_build_object('username', ${quote(ids.user)}));
    INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, ir_slots, scoring_settings)
      VALUES(${quote(ids.league)}, 'R10 lock', ${quote(ids.league)}, ${quote(ids.user)}, 'active', 20, 1, '{"points":1}');
    INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
      VALUES(${quote(ids.member)}, ${quote(ids.league)}, ${quote(ids.user)}, 'commissioner', 'Lock team');
    INSERT INTO public.league_seasons(id, league_id, season_year, is_current)
      VALUES(${quote(ids.season)}, ${quote(ids.league)}, ${year}, true);
    INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members)
      VALUES(${quote(ids.league)}, true);
    SELECT private.activate_league_roster_policy(${quote(ids.league)});
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(${quote(ids.player)}, 'Lock', 'Fixture', 'PG', ARRAY['PG'], NULL, 'AAA');
    INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
      VALUES(${quote(ids.game)}, '002r10lock', ${year}, 1, ${quote(today)}, ${quote(tipoff)}, 'AAA', 'BBB', 'Scheduled');
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
      VALUES(${quote(tipoff)}, ${quote(ids.league)}, ${quote(today)}, ${quote(token)}, 'running', now() + interval '5 minutes');
  COMMIT;`)

  const bFile = marker('b.sql')
  const aFile = marker('a.sql')
  const cFile = marker('c.sql')
  await writeFile(bFile, `BEGIN;
SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${quote(tipoff)} AND scope = ${quote(ids.league)} FOR UPDATE;
\\! touch ${marker('b1')}
SELECT pg_sleep(2);
SELECT private.tipoff_scope_admits(${quote(ids.league)}, ${quote(ids.league)}, true);
COMMIT;
`)
  await writeFile(aFile, `BEGIN;
SELECT public.finish_lineup_tipoff_dispatch(${quote(tipoff)}, ${quote(token)}, NULL, ${quote(ids.league)});
COMMIT;
`)
  await writeFile(cFile, `BEGIN;
UPDATE private.league_roster_policies SET ir_activated_at = NULL, floor_activated_at = NULL WHERE league_id = ${quote(ids.league)};
COMMIT;
`)

  const b = runFile(bFile)
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await access(marker('b1')); break } catch { await sleep(50) }
  }
  await access(marker('b1'))
  const a = runFile(aFile)
  await sleep(500)
  const c = runFile(cFile)
  const [bResult, aResult, cResult] = await Promise.all([b, a, c])
  const errors = [aResult, bResult, cResult].map(result => result.stderr).filter(Boolean)
  const deadlock = errors.some(error => /deadlock detected/i.test(error))
  const dispatchStatus = await run(`SELECT status FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${quote(tipoff)} AND scope = ${quote(ids.league)}`)
  assert.equal(dispatchStatus, 'failed', 'The deactivated scoped dispatch did not end without success')
  const sharedToken = randomUUID()
  await run(`INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
    VALUES(${quote(tipoff)}, '', ${quote(today)}, ${quote(sharedToken)}, 'running', now() + interval '5 minutes')`)
  const sharedPending = await run(`SELECT count(*) FROM public.get_pending_tipoff_members(${quote(tipoff)}, ${quote(sharedToken)}, ARRAY[]::uuid[], 100, '') WHERE league_id = ${quote(ids.league)}`)
  assert.equal(sharedPending, '1', 'The shared selection lost the deactivated league member')
  console.log(JSON.stringify({ deadlock, dispatchStatus, sharedPending: Number(sharedPending), errors: errors.map(error => error.trim().split('\n')[0]) }))
} finally {
  await cleanup()
}

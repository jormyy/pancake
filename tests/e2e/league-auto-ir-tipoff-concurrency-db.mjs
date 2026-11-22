import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
const json = async statement => JSON.parse(await run(statement))

const ids = Object.fromEntries(['league', 'season', 'user', 'member', 'other', 'player', 'healthy', 'game', 'dispatch'].map(key => [key, randomUUID()]))
const token = randomUUID()
const year = 9801
const today = await run("SELECT (now() AT TIME ZONE 'America/New_York')::date")
const tipoff = await run(`SELECT now() + interval '10 minutes'`)

const cleanup = async () => {
  await run(`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at = ${quote(tipoff)};
    DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${quote(tipoff)};
    DELETE FROM public.leagues WHERE id = ${quote(ids.league)};
    DELETE FROM public.nba_games WHERE nba_game_id = '002autoirtipoff';
    DELETE FROM public.players WHERE id = ANY(ARRAY[${quote(ids.player)},${quote(ids.healthy)}]::uuid[]);
    DELETE FROM auth.users WHERE id = ANY(ARRAY[${quote(ids.user)},${quote(ids.other)}]::uuid[]);`)
}

await run(`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at = ${quote(tipoff)};
  DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${quote(tipoff)};
  DELETE FROM public.nba_games WHERE nba_game_id = '002autoirtipoff'`)

try {
  await run(`BEGIN;
    INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
      (${quote(ids.user)}, ${quote(ids.user + '@example.test')}, jsonb_build_object('username', ${quote(ids.user)})),
      (${quote(ids.other)}, ${quote(ids.other + '@example.test')}, jsonb_build_object('username', ${quote(ids.other)}));
    INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, ir_slots, scoring_settings)
      VALUES(${quote(ids.league)}, 'Auto IR concurrency', ${quote(ids.league)}, ${quote(ids.user)}, 'active', 20, 1, '{"points":1}');
    INSERT INTO public.league_members(id, league_id, user_id, role, team_name) VALUES
      (${quote(ids.member)}, ${quote(ids.league)}, ${quote(ids.user)}, 'commissioner', 'Manual team'),
      (${quote(ids.other)}, ${quote(ids.league)}, ${quote(ids.other)}, 'manager', 'Other team');
    INSERT INTO public.league_seasons(id, league_id, season_year, is_current)
      VALUES(${quote(ids.season)}, ${quote(ids.league)}, ${year}, true);
    INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members)
      VALUES(${quote(ids.league)}, true);
    SELECT private.activate_league_roster_policy(${quote(ids.league)});
    INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
      VALUES(${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, false, NULL)
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled = false, enabled_at = NULL;
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return)
      VALUES(${quote(ids.player)}, 'Injured', 'Fixture', 'PG', ARRAY['PG'], 'Out', (${quote(today)}::date + 14)::text),
        (${quote(ids.healthy)}, 'Healthy', 'Fixture', 'PG', ARRAY['PG'], NULL, 'unknown');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES(${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, ${quote(ids.player)}, 'draft'),
        (${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, ${quote(ids.healthy)}, 'draft');
    INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
      VALUES(${quote(ids.game)}, '002autoirtipoff', ${year}, 1, ${quote(today)}, ${quote(tipoff)}, 'AAA', 'BBB', 'Scheduled');
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
      VALUES(${quote(tipoff)}, ${quote(ids.league)}, ${quote(today)}, ${quote(token)}, 'queued', now() + interval '1 minute');
  COMMIT;`)

  const claims = await Promise.all([
    run(`SELECT public.claim_lineup_tipoff_dispatch(${quote(tipoff)}, ${quote(token)}, ${quote(ids.league)})`),
    run(`SELECT public.claim_lineup_tipoff_dispatch(${quote(tipoff)}, ${quote(token)}, ${quote(ids.league)})`),
  ])
  assert.equal(claims.filter(value => value === today).length, 1, 'Concurrent claims both won the window.')

  const pending = await json(`SELECT COALESCE(jsonb_agg(row_to_json(m)), '[]') FROM public.get_pending_auto_ir_members(${quote(today)}, ${quote(tipoff)}, ${quote(token)}, ARRAY[]::uuid[], 100, false, ${quote(ids.league)}) m`)
  assert.equal(pending.length, 1, 'The claimed window does not list the Auto Lineup off member.')

  const work = () => run(`SELECT public.auto_manage_ir_service(${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)})`)
  const mark = () => run(`SELECT public.mark_tipoff_ir_member_done(${quote(tipoff)}, ${quote(token)}, ${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)}, ${quote(ids.league)})`)
  await Promise.all([work(), work(), mark(), mark()])

  assert.equal(await run(`SELECT count(*) FROM public.lineup_tipoff_members WHERE tipoff_at = ${quote(tipoff)} AND member_id = ${quote(ids.member)}`), '1',
    'Concurrent dispatch wrote more than one receipt.')
  assert.equal(await run(`SELECT is_on_ir FROM public.roster_players WHERE league_id = ${quote(ids.league)} AND member_id = ${quote(ids.member)} AND player_id = ${quote(ids.player)}`), 't',
    'The injured player is not on IR.')
  assert.equal(await run(`SELECT count(*) FROM public.roster_transactions WHERE league_id = ${quote(ids.league)} AND member_id = ${quote(ids.member)} AND transaction_type = 'ir_designate'`), '1',
    'Concurrent dispatch applied the IR move more than once.')
  assert.equal(await run(`SELECT count(*) FROM public.get_pending_auto_ir_members(${quote(today)}, ${quote(tipoff)}, ${quote(token)}, ARRAY[]::uuid[], 100, false, ${quote(ids.league)})`), '0',
    'A completed member repeats in the same window.')

  await run(`SELECT public.finish_lineup_tipoff_dispatch(${quote(tipoff)}, ${quote(token)}, NULL, ${quote(ids.league)})`)
  const retryToken = randomUUID()
  await run(`UPDATE public.lineup_tipoff_dispatches SET status = 'queued', token = ${quote(retryToken)}, lease_until = now() + interval '1 minute' WHERE tipoff_at = ${quote(tipoff)} AND scope = ${quote(ids.league)}`)
  assert.equal(await run(`SELECT public.claim_lineup_tipoff_dispatch(${quote(tipoff)}, ${quote(retryToken)}, ${quote(ids.league)})`), today, 'The repeated window was not claimed.')
  assert.equal(await run(`SELECT count(*) FROM public.get_pending_auto_ir_members(${quote(today)}, ${quote(tipoff)}, ${quote(retryToken)}, ARRAY[]::uuid[], 100, false, ${quote(ids.league)})`), '0',
    'A repeated dispatch reprocesses a completed member.')
  await run(`SELECT public.auto_manage_ir_service(${quote(ids.league)}, ${quote(ids.season)}, ${quote(ids.member)})`)
  assert.equal(await run(`SELECT count(*) FROM public.roster_transactions WHERE league_id = ${quote(ids.league)} AND member_id = ${quote(ids.member)} AND transaction_type = 'ir_designate'`), '1',
    'A repeated dispatch applied the IR move again.')
  await run(`SELECT public.finish_lineup_tipoff_dispatch(${quote(tipoff)}, ${quote(retryToken)}, NULL, ${quote(ids.league)})`)

  console.log(JSON.stringify({ claims: claims.map(value => value || null), pending: pending.length, receipts: 1, irDesignations: 1 }))
} finally {
  await cleanup()
}

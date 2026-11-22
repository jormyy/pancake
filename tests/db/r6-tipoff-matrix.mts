import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const db = new URL(Deno.env.get('SUPABASE_DB_URL')!)
const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
const oldRoot = Deno.env.get('R6_OLD_ROOT')!
const newRoot = Deno.env.get('R6_NEW_ROOT')!
const q = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`

async function sql(source: string) {
  const result = await new Deno.Command('psql', {
    args: [db.href, '-XqAtv', 'ON_ERROR_STOP=1', '-c', source],
    env: { PGOPTIONS: '-c statement_timeout=30000' },
    stdout: 'piped', stderr: 'piped',
  }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

const serve = (root: string, port: number) => new Deno.Command('deno', {
  args: ['run', '--allow-all', new URL('./r5b-serve.mts', import.meta.url).pathname],
  env: { ...Deno.env.toObject(), R5B_PORT: String(port), R5B_ENTRY: `${root}/supabase/functions/lineup-optimizer/index.ts` },
  stdout: 'null', stderr: 'inherit',
}).spawn()

const waitFor = async (port: number) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const connection = await Deno.connect({ hostname: '127.0.0.1', port })
      connection.close()
      return
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`worker on ${port} did not start`)
}

const call = async (port: number, body: Record<string, unknown>) => {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'x-internal-function-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

const year = Number(await sql('SELECT COALESCE(max(season_year),9499)+1 FROM public.season_weeks'))
const today = await sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
const tipoff = new Date(Date.now() + 600_000).toISOString()
const team = 'Z' + randomUUID().slice(0, 2).toUpperCase()
const opponent = 'Y' + randomUUID().slice(0, 2).toUpperCase()

const oldLineup = serve(oldRoot, 8201)
const newLineup = serve(newRoot, 8203)

type Fixture = {
  policyLeague: string; policySeason: string; unrelatedLeague: string; unrelatedSeason: string
  manualMember: string; optinMember: string; unrelatedMember: string
  manualInjured: string; optinInjured: string; unrelatedHealthy: string
  game: string; sharedToken: string; policyToken: string
}

async function fixture(): Promise<Fixture> {
  const ids = Object.fromEntries(['user', 'otherUser', 'policyLeague', 'policySeason', 'unrelatedLeague', 'unrelatedSeason',
    'manualMember', 'optinMember', 'unrelatedMember', 'manualInjured', 'manualHealthy', 'optinInjured', 'optinHealthy',
    'unrelatedHealthy', 'game', 'sharedToken', 'policyToken'].map((key) => [key, randomUUID()])) as Record<string, string>
  await sql(`BEGIN;
    INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
      (${q(ids.user)},${q(ids.user + '@example.test')},'{}'),
      (${q(ids.otherUser)},${q(ids.otherUser + '@example.test')},'{}');
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,timezone,scoring_settings) VALUES
      (${q(ids.policyLeague)},'Policy',${q(ids.policyLeague)},${q(ids.user)},'active',20,1,'Pacific/Kiritimati','{"points":1}'),
      (${q(ids.unrelatedLeague)},'Unrelated',${q(ids.unrelatedLeague)},${q(ids.otherUser)},'active',20,1,'Pacific/Kiritimati','{"points":1}');
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES
      (${q(ids.policySeason)},${q(ids.policyLeague)},${year},true),
      (${q(ids.unrelatedSeason)},${q(ids.unrelatedLeague)},${year},true);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES
      (${q(ids.manualMember)},${q(ids.policyLeague)},${q(ids.user)},'commissioner','Manual'),
      (${q(ids.optinMember)},${q(ids.policyLeague)},${q(ids.otherUser)},'manager','Optin'),
      (${q(ids.unrelatedMember)},${q(ids.unrelatedLeague)},${q(ids.otherUser)},'commissioner','Unrelated');
    UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL WHERE league_id=${q(ids.policyLeague)} AND member_id=${q(ids.manualMember)};
    UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now() WHERE league_id=${q(ids.policyLeague)} AND member_id=${q(ids.optinMember)};
    UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now() WHERE league_id=${q(ids.unrelatedLeague)} AND member_id=${q(ids.unrelatedMember)};
    INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
      VALUES(${q(ids.policyLeague)},16,true,now(),now());
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,injury_status,injury_expected_return,nba_team) VALUES
      (${q(ids.manualInjured)},'Manual','Injured','PG',ARRAY['PG'],'Out',${q(today)}::date+14,${q(team)}),
      (${q(ids.manualHealthy)},'Manual','Healthy','PG',ARRAY['PG'],NULL,'unknown',${q(team)}),
      (${q(ids.optinInjured)},'Optin','Injured','PG',ARRAY['PG'],'Out',${q(today)}::date+14,${q(team)}),
      (${q(ids.optinHealthy)},'Optin','Healthy','PG',ARRAY['PG'],NULL,'unknown',${q(team)}),
      (${q(ids.unrelatedHealthy)},'Unrelated','Healthy','PG',ARRAY['PG'],NULL,'unknown',${q(team)});
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES
      (${q(ids.policyLeague)},${q(ids.policySeason)},${q(ids.manualMember)},${q(ids.manualInjured)},'draft'),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${q(ids.manualMember)},${q(ids.manualHealthy)},'draft'),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${q(ids.optinMember)},${q(ids.optinInjured)},'draft'),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${q(ids.optinMember)},${q(ids.optinHealthy)},'draft'),
      (${q(ids.unrelatedLeague)},${q(ids.unrelatedSeason)},${q(ids.unrelatedMember)},${q(ids.unrelatedHealthy)},'draft');
    INSERT INTO public.player_season_averages(league_id,league_season_id,season_year,player_id,averages,avg_fantasy_points,version) VALUES
      (${q(ids.policyLeague)},${q(ids.policySeason)},${year},${q(ids.manualInjured)},'{}'::jsonb,10,1),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${year},${q(ids.manualHealthy)},'{}'::jsonb,20,1),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${year},${q(ids.optinInjured)},'{}'::jsonb,10,1),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${year},${q(ids.optinHealthy)},'{}'::jsonb,20,1),
      (${q(ids.unrelatedLeague)},${q(ids.unrelatedSeason)},${year},${q(ids.unrelatedHealthy)},'{}'::jsonb,20,1);
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
      VALUES(${year},1,${q(today)}::date-6,${q(today)}::date)
      ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
    INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id) VALUES
      (${q(ids.policyLeague)},${q(ids.policySeason)},1,${q(ids.manualMember)},${q(ids.optinMember)});
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
      VALUES(${q(ids.game)},${q('002' + ids.game)},${year},1,${q(today)}::date,${q(tipoff)}::timestamptz,${q(team)},${q(opponent)},'Scheduled');
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,scope,game_date,token,status,lease_until) VALUES
      (${q(tipoff)}::timestamptz,'',${q(today)}::date,${q(ids.sharedToken)},'queued',now()+interval '2 minutes'),
      (${q(tipoff)}::timestamptz,${q(ids.policyLeague)},${q(today)}::date,${q(ids.policyToken)},'queued',now()+interval '2 minutes');
    COMMIT;`)
  return {
    policyLeague: ids.policyLeague, policySeason: ids.policySeason,
    unrelatedLeague: ids.unrelatedLeague, unrelatedSeason: ids.unrelatedSeason,
    manualMember: ids.manualMember, optinMember: ids.optinMember, unrelatedMember: ids.unrelatedMember,
    manualInjured: ids.manualInjured, optinInjured: ids.optinInjured, unrelatedHealthy: ids.unrelatedHealthy,
    game: ids.game, sharedToken: ids.sharedToken, policyToken: ids.policyToken,
  }
}

async function cleanup(f: Fixture) {
  await sql(`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at=${q(tipoff)}::timestamptz;
    DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at=${q(tipoff)}::timestamptz;
    DELETE FROM public.leagues WHERE id=ANY(ARRAY[${q(f.policyLeague)},${q(f.unrelatedLeague)}]::uuid[]);
    DELETE FROM public.nba_games WHERE id=${q(f.game)};
    DELETE FROM public.season_weeks WHERE season_year=${year};
    DELETE FROM auth.users WHERE id IN (SELECT user_id FROM public.league_members WHERE league_id=ANY(ARRAY[${q(f.policyLeague)},${q(f.unrelatedLeague)}]::uuid[]));`)
}

async function readback(f: Fixture) {
  const ir = await sql(`SELECT count(*) FROM public.roster_players WHERE league_id=${q(f.policyLeague)} AND is_on_ir`)
  const manualStarters = await sql(`SELECT count(*) FROM public.weekly_lineups WHERE league_id=${q(f.policyLeague)} AND member_id=${q(f.manualMember)}`)
  const optinStarters = await sql(`SELECT count(*) FROM public.weekly_lineups WHERE league_id=${q(f.policyLeague)} AND member_id=${q(f.optinMember)}`)
  const unrelatedStarters = await sql(`SELECT count(*) FROM public.weekly_lineups WHERE league_id=${q(f.unrelatedLeague)} AND member_id=${q(f.unrelatedMember)}`)
  const duplicates = await sql(`SELECT count(*) FROM (SELECT player_id FROM public.roster_transactions WHERE league_id=ANY(ARRAY[${q(f.policyLeague)},${q(f.unrelatedLeague)}]::uuid[]) GROUP BY player_id HAVING count(*)>1) dup`)
  return { ir, manualStarters, optinStarters, unrelatedStarters, duplicates }
}

const results: Record<string, unknown> = {}
try {
  await sql(`UPDATE private.worker_controls SET paused=true WHERE id`)
  await waitFor(8201)
  await waitFor(8203)
  for (const [label, port] of [['old-old', 8201], ['old-new', 8203], ['new-new', 8203]] as const) {
    const f = await fixture()
    try {
      const shared = await call(port, { mode: 'pre_tipoff', tipoffAt: tipoff, token: f.sharedToken })
      await sql(`UPDATE public.lineup_tipoff_dispatches SET status='running', lease_until=now()+interval '1 minute' WHERE tipoff_at=${q(tipoff)}::timestamptz AND scope=${q(f.policyLeague)}`)
      await sql(`UPDATE public.lineup_tipoff_dispatches SET status='queued' WHERE tipoff_at=${q(tipoff)}::timestamptz AND scope=${q(f.policyLeague)}`)
      const policy = await call(port, { mode: 'pre_tipoff', tipoffAt: tipoff, token: f.policyToken, leagueId: f.policyLeague })
      results[label] = { shared: shared.status, sharedBody: shared.body, policy: policy.status, policyBody: policy.body, ...await readback(f) }
    } finally { await cleanup(f) }
  }
  const f = await fixture()
  try {
    const shared = await call(8201, { mode: 'pre_tipoff', tipoffAt: tipoff, token: f.sharedToken })
    const policy = await call(8201, { mode: 'pre_tipoff', tipoffAt: tipoff, token: f.policyToken, leagueId: f.policyLeague })
    await sql(`UPDATE private.league_roster_policies SET ir_activated_at=NULL WHERE league_id=${q(f.policyLeague)}`)
    const retry = await call(8201, { mode: 'pre_tipoff', tipoffAt: tipoff, token: f.policyToken, leagueId: f.policyLeague })
    results.rollback = { shared: shared.status, policy: policy.status, retry: retry.status, ...await readback(f) }
  } finally { await cleanup(f) }
  console.log(JSON.stringify(results))
} finally {
  await sql(`UPDATE private.worker_controls SET paused=false WHERE id`).catch(() => {})
  try { oldLineup.kill('SIGTERM') } catch { /* already gone */ }
  try { newLineup.kill('SIGTERM') } catch { /* already gone */ }
}

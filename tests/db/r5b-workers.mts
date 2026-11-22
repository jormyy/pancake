import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const db = new URL(Deno.env.get('SUPABASE_DB_URL')!)
const api = new URL(Deno.env.get('SUPABASE_URL')!)
const lineupRoot = Deno.env.get('R5B_LINEUP_ROOT')!
const waiversRoot = Deno.env.get('R5B_WAIVERS_ROOT')!
const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
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

const ids = Object.fromEntries(['user', 'otherUser', 'league', 'season', 'member', 'other', 'injured', 'healthy', 'game', 'dispatch', 'policyDispatch', 'otherGame', 'fa1', 'fa2'].map((key) => [key, randomUUID()]))
const year = Number(await sql('SELECT COALESCE(max(season_year),9299)+1 FROM public.season_weeks'))
const today = await sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
const tipoff = new Date(Date.now() + 600_000).toISOString()
const team = 'Z' + randomUUID().slice(0, 2).toUpperCase()
const opponent = 'Y' + randomUUID().slice(0, 2).toUpperCase()

const serve = (root: string, port: number, entry: string) => {
  const child = new Deno.Command('deno', {
    args: ['run', '--allow-all', new URL('./r5b-serve.mts', import.meta.url).pathname],
    env: { ...Deno.env.toObject(), R5B_PORT: String(port), R5B_ENTRY: `${root}/supabase/functions/${entry}` },
    stdout: 'null', stderr: 'inherit',
  }).spawn()
  return child
}

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

const lineup = serve(lineupRoot, 8101, 'lineup-optimizer/index.ts')
const waivers = serve(waiversRoot, 8102, 'process-waivers/index.ts')

try {
  await waitFor(8101)
  await waitFor(8102)

  await sql(`BEGIN;
    INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
      (${q(ids.user)},${q(ids.user + '@example.test')},'{}'),
      (${q(ids.otherUser)},${q(ids.otherUser + '@example.test')},'{}');
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,timezone,scoring_settings)
      VALUES(${q(ids.league)},'Worker matrix',${q(ids.league)},${q(ids.user)},'active',20,1,'Pacific/Kiritimati','{"points":1}');
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${q(ids.season)},${q(ids.league)},${year},true);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES
      (${q(ids.member)},${q(ids.league)},${q(ids.user)},'commissioner','Manual one'),
      (${q(ids.other)},${q(ids.league)},${q(ids.otherUser)},'manager','Manual two');
    UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL WHERE league_id=${q(ids.league)};
    INSERT INTO private.league_roster_policies(league_id,weekly_roster_floor,auto_ir_all_members,floor_activated_at,ir_activated_at)
      VALUES(${q(ids.league)},16,true,now(),now());
    INSERT INTO private.screen_refresh_queue(league_id,league_season_id,averages_initialized,averages_scoring)
      SELECT ${q(ids.league)},${q(ids.season)},true,league.scoring_settings FROM public.leagues league WHERE league.id=${q(ids.league)}
      ON CONFLICT (league_season_id) DO UPDATE SET averages_initialized=true, averages_scoring=EXCLUDED.averages_scoring;
    INSERT INTO private.waiver_run_settlements(league_id,league_season_id,process_date) VALUES(${q(ids.league)},${q(ids.season)},${q(today)}::date);
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,${q(today)}::date-6,${q(today)}::date);
    INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
      VALUES(${q(ids.league)},${q(ids.season)},1,${q(ids.member)},${q(ids.other)});
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,injury_status,injury_expected_return,nba_team) VALUES
      (${q(ids.injured)},'Injured','Manual','PG',ARRAY['PG'],'Out',${q(today)}::date+14,${q(team)}),
      (${q(ids.healthy)},'Healthy','Manual','PG',ARRAY['PG'],NULL,'unknown',${q(team)});
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES
      (${q(ids.league)},${q(ids.season)},${q(ids.member)},${q(ids.injured)},'draft'),
      (${q(ids.league)},${q(ids.season)},${q(ids.member)},${q(ids.healthy)},'draft');
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,injury_status,injury_expected_return,nba_team) VALUES
      (${q(ids.fa1)},'Free','One','PG',ARRAY['PG'],NULL,'unknown',${q(team)}),
      (${q(ids.fa2)},'Free','Two','PG',ARRAY['PG'],NULL,'unknown',${q(team)});
    INSERT INTO public.player_season_averages(league_id,league_season_id,season_year,player_id,averages,avg_fantasy_points,version) VALUES
      (${q(ids.league)},${q(ids.season)},${year},${q(ids.fa1)},'{}'::jsonb,20,1),
      (${q(ids.league)},${q(ids.season)},${year},${q(ids.fa2)},'{}'::jsonb,10,1);
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES
      (${q(ids.game)},${q('002' + ids.game)},${year},1,${q(today)}::date,${q(tipoff)}::timestamptz,${q(team)},${q(opponent)},'Scheduled');
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,scope,game_date,token,status,lease_until) VALUES
      (${q(tipoff)}::timestamptz,'',${q(today)}::date,${q(ids.dispatch)},'queued',now()+interval '2 minutes'),
      (${q(tipoff)}::timestamptz,${q(ids.league)},${q(today)}::date,${q(ids.policyDispatch)},'queued',now()+interval '2 minutes');
    COMMIT;`)

  const before = await sql(`SELECT count(*) FROM public.roster_players WHERE league_id=${q(ids.league)} AND is_on_ir`)
  const daily = await call(8101, { mode: 'daily', date: today })
  const preTipoff = await call(8101, { mode: 'pre_tipoff', tipoffAt: tipoff, token: ids.dispatch })
  const policyTipoff = await call(8101, { mode: 'pre_tipoff', tipoffAt: tipoff, token: ids.policyDispatch, leagueId: ids.league })
  const floor = await call(8102, {})
  const after = await sql(`SELECT count(*) FROM public.roster_players WHERE league_id=${q(ids.league)} AND is_on_ir`)
  const awards = await sql(`SELECT count(*) FROM private.roster_floor_awards WHERE league_id=${q(ids.league)}`)
  const starters = await sql(`SELECT count(*) FROM public.weekly_lineups WHERE league_id=${q(ids.league)}`)
  const dispatch = await sql(`SELECT status FROM public.lineup_tipoff_dispatches WHERE token=${q(ids.dispatch)}`)

  console.log(JSON.stringify({
    lineupRoot, waiversRoot,
    daily: daily.status, preTipoff: preTipoff.status, policyTipoff: policyTipoff.status, floor: floor.status,
    irBefore: before, irAfter: after, awards, starters, dispatch,
  }))
} finally {
  try { lineup.kill('SIGTERM') } catch { /* already gone */ }
  try { waivers.kill('SIGTERM') } catch { /* already gone */ }
  await sql(`DELETE FROM public.leagues WHERE id=${q(ids.league)}; DELETE FROM public.nba_games WHERE id=${q(ids.game)}; DELETE FROM public.season_weeks WHERE season_year=${year}; DELETE FROM auth.users WHERE id=ANY(ARRAY[${q(ids.user)},${q(ids.otherUser)}]::uuid[]);`)
}

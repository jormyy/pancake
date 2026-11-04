import { processDaily } from '../../supabase/functions/lineup-optimizer/daily.ts'
import assert from 'node:assert/strict'
import { processPreTipoff, tipoffAssignments, type TipoffContext } from '../../supabase/functions/lineup-optimizer/preTipoff.ts'

const db = new URL(Deno.env.get('SUPABASE_DB_URL')!)
const api = new URL(Deno.env.get('SUPABASE_URL')!)
assert.equal(db.hostname, '127.0.0.1')
assert.equal(db.port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
assert.equal(api.hostname, '127.0.0.1')
assert.equal(api.port, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321')
const q = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`
async function sql(source: string) {
  const result = await new Deno.Command('psql', {
    args: [db.href, '-XqAtv', 'ON_ERROR_STOP=1', '-c', source],
    env: { PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=10000' },
    stdout: 'piped', stderr: 'piped',
  }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const ids = Object.fromEntries(['user', 'league', 'season', 'member', 'early', 'late', 'center', 'earlyGame', 'lateGame', 'dispatchGame', 'run'].map(key => [key, crypto.randomUUID()]))
const playerIds = [ids.early, ids.late, ids.center].map(q).join(',')
let year: number
const dispatches: string[] = []
const lineups = async () => JSON.parse(await sql(`SELECT COALESCE(jsonb_agg(jsonb_build_object('player',player_id,'slot',slot_type,'id',id,'setAt',set_at) ORDER BY player_id),'[]') FROM public.weekly_lineups WHERE member_id=${q(ids.member)}`))
const context = async (): Promise<TipoffContext> => JSON.parse(await sql(`SELECT public.get_pre_tipoff_lineup_context(${q(ids.league)},${q(ids.season)},${q(ids.member)})`))
async function dispatch() {
  const token = crypto.randomUUID()
  const tipoffAt = await sql(`INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,token,status,lease_until)
    VALUES(clock_timestamp()+interval '90 seconds',(now() AT TIME ZONE 'America/New_York')::date,${q(token)},'queued',now()+interval '1 minute') RETURNING tipoff_at`)
  await sql(`INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(${q(ids.dispatchGame)},${q('002'+ids.dispatchGame)},${year},1,(now() AT TIME ZONE 'America/New_York')::date,${q(tipoffAt)},'D','Q','Scheduled')
    ON CONFLICT(id) DO UPDATE SET game_time=EXCLUDED.game_time`)
  dispatches.push(tipoffAt)
  return { tipoffAt, token }
}
async function optimize() {
  const result = await processPreTipoff(await dispatch())
  assert.equal(result.failed, 0, JSON.stringify(result))
  assert.equal(result.claimed, true)
  return result
}
function has(rows: { player: string; slot: string }[], player: string, slot: string) {
  return rows.some(row => row.player === player && row.slot === slot)
}

Deno.test('autoset uses real context, projections, leases and atomic writes', async t => {
  assert.equal(await sql('SELECT count(*) FROM public.leagues'), '0', 'Use a fresh, empty isolated database')
  try {
    year = Number(await sql('SELECT COALESCE(max(season_year),9399)+1 FROM public.season_weeks'))
    await sql(`BEGIN;
      INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${q(ids.user)},${q(ids.user+'@example.test')},jsonb_build_object('username',${q(ids.user)}));
      INSERT INTO public.leagues(id,name,slug,commissioner_id,status,scoring_settings) VALUES(${q(ids.league)},'Autoset DB fixture',${q(ids.league)},${q(ids.user)},'active','{"points":1}');
      INSERT INTO public.league_members(id,league_id,user_id,role) VALUES(${q(ids.member)},${q(ids.league)},${q(ids.user)},'commissioner');
      INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${q(ids.season)},${q(ids.league)},${year},true);
      INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,(now() AT TIME ZONE 'America/New_York')::date,(now() AT TIME ZONE 'America/New_York')::date+6);
      INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team) VALUES
        (${q(ids.early)},'Early','Fixture','PG',ARRAY['PG'],'E'),
        (${q(ids.late)},'Late','Fixture','PG',ARRAY['PG'],'L'),
        (${q(ids.center)},'Center','Fixture','C',ARRAY['C'],'L');
      INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
        SELECT ${q(ids.league)},${q(ids.season)},${q(ids.member)},id,'draft' FROM public.players WHERE id IN (${playerIds});
      DELETE FROM public.lineup_slot_templates WHERE league_id=${q(ids.league)};
      INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${q(ids.league)},'PG',1),(${q(ids.league)},'UTIL',1);
      INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES
        (${q(ids.earlyGame)},${q('002'+ids.earlyGame)},${year},1,(now() AT TIME ZONE 'America/New_York')::date,now()+interval '90 seconds','E','X','Scheduled'),
        (${q(ids.lateGame)},${q('002'+ids.lateGame)},${year},1,(now() AT TIME ZONE 'America/New_York')::date,now()+interval '3 hours','L','Y','Scheduled');
      INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,week_number,projection_date,status,completed_at)
        VALUES(${q(ids.run)},'fantasypros','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',${year},1,(now() AT TIME ZONE 'America/New_York')::date,'success',now());
      INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,season_year,week_number,projection_date,fetched_at,source_player_name,normalized_player_name,player_id,match_status,points,games_played)
        SELECT r.id,r.projection_type,r.source_url,p.n,${year},1,r.projection_date,now(),'Fixture','fixture',p.id,'matched',p.points,1
        FROM public.projection_sync_runs r CROSS JOIN (VALUES (${q(ids.early)}::uuid,1,50),(${q(ids.late)}::uuid,2,45),(${q(ids.center)}::uuid,3,40)) p(id,n,points) WHERE r.id=${q(ids.run)};
      INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set) VALUES
        (${q(ids.league)},${q(ids.season)},${q(ids.member)},${q(ids.early)},1,(now() AT TIME ZONE 'America/New_York')::date,'UTIL',false),
        (${q(ids.league)},${q(ids.season)},${q(ids.member)},${q(ids.late)},1,(now() AT TIME ZONE 'America/New_York')::date,'PG',false);
      COMMIT;`)
    await t.step('daily runs honor Bench pins through the real context and write guard', async () => {
      const date = await sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
      await sql(`SELECT set_config('request.jwt.claim.sub',${q(ids.user)},false);
        SELECT public.set_lineup_player_pin(${q(ids.league)},${q(ids.early)},${q(date)},'bench')`)
      const result = await processDaily({ date })
      assert.equal(result.failed, 0)
      assert.equal(result.optimized, 1)
      const rows = await lineups()
      assert.ok(has(rows,ids.late,'PG') && has(rows,ids.center,'UTIL'))
      await sql(`SELECT set_config('request.jwt.claim.sub',${q(ids.user)},false);
        SELECT public.set_lineup_player_pin(${q(ids.league)},${q(ids.early)},${q(date)},NULL);
        UPDATE public.lineup_optimizer_settings SET last_daily_optimized_date=NULL WHERE member_id=${q(ids.member)}`)
    })
    await t.step('concurrent daily runs write once and repeated delivery preserves the lineup', async () => {
      const date = await sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
      const results = await Promise.all([processDaily({ date }), processDaily({ date })])
      assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0, JSON.stringify(results))
      assert.equal(results.reduce((sum, result) => sum + result.optimized, 0), 1)
      assert.equal(await sql(`SELECT last_daily_optimized_date FROM public.lineup_optimizer_settings WHERE member_id=${q(ids.member)}`), date)
      const before = await lineups()
      assert.equal((await processDaily({ date })).optimized, 0)
      assert.deepEqual(await lineups(), before)
      assert.equal((await optimize()).optimized, 0)
      assert.deepEqual(await lineups(), before)
      await sql(`UPDATE public.lineup_optimizer_settings SET last_daily_optimized_date=NULL WHERE member_id=${q(ids.member)}`)
      assert.equal(await sql(`SELECT public.apply_daily_lineup(${q(date)},${q(ids.league)},${q(ids.season)},${q(ids.member)},'[]')`), 'f')
      assert.deepEqual(await lineups(), before)
      assert.equal(await sql(`SELECT last_daily_optimized_date FROM public.lineup_optimizer_settings WHERE member_id=${q(ids.member)}`), date)
    })
    await t.step('pin revisions change pre-tipoff starters and clearing restores projections', async () => {
      const date = await sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
      await sql(`SELECT set_config('request.jwt.claim.sub',${q(ids.user)},false);
        SELECT public.set_lineup_player_pin(${q(ids.league)},${q(ids.center)},${q(date)},'start')`)
      assert.equal((await optimize()).optimized, 1)
      assert.ok(has(await lineups(),ids.center,'UTIL'))
      await sql(`SELECT set_config('request.jwt.claim.sub',${q(ids.user)},false);
        SELECT public.set_lineup_player_pin(${q(ids.league)},${q(ids.center)},${q(date)},NULL)`)
      assert.equal((await optimize()).optimized, 1)
      assert.ok(has(await lineups(),ids.late,'UTIL'))
    })
    await t.step('staggered starts preserve UTIL without lowering the 95-point primary objective', async () => {
      const c = await context()
      assert.ok(c.players.find(p => p.playerId === ids.early)?.gameTime)
      const projections = JSON.parse(await sql(`SELECT jsonb_agg(r) FROM public.get_league_projection_rows(${q(ids.league)},${year},(now() AT TIME ZONE 'America/New_York')::date,'today',ARRAY[${playerIds}]::uuid[],10,0) r`))
      assert.deepEqual(projections.map((p: { projection_fantasy_points: number }) => p.projection_fantasy_points).sort(), [40,45,50])
      await optimize()
      const rows = await lineups()
      assert.ok(has(rows,ids.early,'PG') && has(rows,ids.late,'UTIL'))
      assert.equal(rows.length,2)
    })
    await t.step('unchanged reruns preserve row IDs and timestamps', async () => {
      const before = await lineups()
      assert.equal((await optimize()).optimized,0)
      assert.deepEqual(await lineups(),before)
    })
    await t.step('confirmed inactive late guard yields UTIL while the early starter stays locked', async () => {
      await sql(`UPDATE public.nba_games SET status='InProgress',started_at=now()-interval '1 second' WHERE id=${q(ids.earlyGame)};
        UPDATE public.players SET injury_status='Out' WHERE id IN (${q(ids.early)},${q(ids.late)})`)
      const early = (await lineups()).find((r: {player:string}) => r.player===ids.early)
      await optimize()
      const rows = await lineups()
      assert.ok(has(rows,ids.early,'PG') && has(rows,ids.center,'UTIL'))
      assert.deepEqual(rows.find((r: {player:string}) => r.player===ids.early),early)
    })
    await t.step('no legal replacement keeps the legal fallback and excludes IR', async () => {
      await sql(`UPDATE public.roster_players SET is_on_ir=true WHERE player_id=${q(ids.center)} AND league_id=${q(ids.league)}`)
      await optimize()
      const rows = await lineups()
      assert.ok(has(rows,ids.early,'PG') && has(rows,ids.late,'UTIL'))
      assert.equal(rows.length,2)
      await sql(`UPDATE public.roster_players SET is_on_ir=false WHERE player_id=${q(ids.center)} AND league_id=${q(ids.league)}`)
    })
    await t.step('postponement carries no playing value and cannot displace a healthy active option', async () => {
      await sql(`UPDATE public.players SET injury_status=NULL,nba_team='Z' WHERE id=${q(ids.center)};
        UPDATE public.nba_games SET status='Scheduled',started_at=NULL,game_time=now()+interval '90 seconds',home_team='Z',away_team='X' WHERE id=${q(ids.earlyGame)};
        UPDATE public.nba_games SET game_status_text='PPD' WHERE id=${q(ids.lateGame)};
        UPDATE public.players SET injury_status=NULL WHERE id=${q(ids.late)}`)
      const c = await context()
      assert.equal(c.players.find(p=>p.playerId===ids.late)?.hasGame,false)
      assert.equal(c.players.find(p=>p.playerId===ids.late)?.gameTime,null)
      await optimize()
      assert.ok(has(await lineups(),ids.center,'UTIL'))
    })
    await t.step('equal rankings preserve deterministic assignments on repeated database runs', async () => {
      await sql(`UPDATE public.players SET nba_team='E',injury_status=NULL WHERE id=${q(ids.early)};
        UPDATE public.players SET nba_team='L' WHERE id=${q(ids.center)};
        UPDATE public.nba_games SET home_team='E' WHERE id=${q(ids.earlyGame)};
        UPDATE public.nba_games SET game_status_text=NULL WHERE id=${q(ids.lateGame)};
        UPDATE public.fantasypros_projection_rows SET points=40 WHERE run_id=${q(ids.run)}`)
      await optimize()
      const before = await lineups()
      await optimize()
      assert.deepEqual(await lineups(),before)
      const c = await context()
      const points=c.players.map(p=>({player_id:p.playerId,projection_fantasy_points:40}))
      assert.deepEqual(tipoffAssignments(c,points),tipoffAssignments({...c,players:[...c.players].reverse()},points.reverse()))
    })
    await t.step('two concurrent workers claim once and write one member receipt', async () => {
      const body=await dispatch()
      const before=await lineups()
      const results=await Promise.all([processPreTipoff(body),processPreTipoff(body)])
      assert.equal(results.filter(r=>r.claimed).length,1)
      assert.equal(results.reduce((sum,r)=>sum+r.failed,0),0)
      assert.equal(await sql(`SELECT count(*) FROM public.lineup_tipoff_members WHERE tipoff_at=${q(body.tipoffAt)}`),'1')
      assert.deepEqual(await lineups(),before)
    })
    await t.step('a stale worker cannot overwrite a newer token', async () => {
      const body=await dispatch()
      const assignments=tipoffAssignments(await context(),[])
      await sql(`SELECT public.claim_lineup_tipoff_dispatch(${q(body.tipoffAt)},${q(body.token)});
        UPDATE public.lineup_tipoff_dispatches SET token=gen_random_uuid() WHERE tipoff_at=${q(body.tipoffAt)}`)
      const before=await lineups()
      const result=await new Deno.Command('psql',{args:[db.href,'-XqAtv','ON_ERROR_STOP=1','-c',`SELECT public.apply_pre_tipoff_lineup(${q(body.tipoffAt)},${q(body.token)},${q(ids.league)},${q(ids.season)},${q(ids.member)},${q(JSON.stringify(assignments))})`],stdout:'piped',stderr:'piped'}).output()
      assert.notEqual(result.code,0)
      assert.match(new TextDecoder().decode(result.stderr),/Tipoff claim is no longer current/)
      assert.deepEqual(await lineups(),before)
    })
  } finally {
    await sql(`DELETE FROM public.lineup_tipoff_members WHERE member_id=${q(ids.member)};
      DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at IN (${dispatches.map(q).join(',') || 'NULL'});
      DELETE FROM public.leagues WHERE id=${q(ids.league)};
      DELETE FROM public.projection_sync_runs WHERE id=${q(ids.run)};
      DELETE FROM public.players WHERE id IN (${playerIds});
      DELETE FROM public.nba_games WHERE id IN (${q(ids.earlyGame)},${q(ids.lateGame)},${q(ids.dispatchGame)});
      DELETE FROM public.season_weeks WHERE season_year=${year ?? 0};
      DELETE FROM auth.users WHERE id=${q(ids.user)}`)
  }
})

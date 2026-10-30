import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.equal(new URL(api).hostname, '127.0.0.1')
assert.equal(new URL(db).hostname, '127.0.0.1')
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '65222')
const internalToken = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(internalToken)
const edgeRuntime = Deno.env.get('PRE_TIPOFF_EDGE_RUNTIME') === '1'

async function sql(command: string) {
  const result = await new Deno.Command('psql', {
    args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1'],
    stdin: 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn()
  const writer = result.stdin.getWriter()
  await writer.write(new TextEncoder().encode(command))
  await writer.close()
  const output = await result.output()
  assert.equal(output.code, 0, new TextDecoder().decode(output.stderr))
  return new TextDecoder().decode(output.stdout).trim()
}

type Fixture = { league_id: string; season_id: string; member_ids: string[]; user_ids: string[] }
let handler: ((request: Request) => Promise<Response>) | undefined
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
Object.defineProperty(Deno, 'serve', { value: (serveHandler: typeof handler) => { handler = serveHandler } })
try { await import('../../functions/lineup-optimizer/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
assert.ok(handler)

const cases = [
  { pending: false, failMember: false, teams: 3 },
  { pending: true, failMember: false, teams: 3 },
  { pending: true, failMember: true, teams: 3 },
  { pending: true, failMember: true, teams: 103 },
]
for (const { pending, failMember, teams } of cases) {
  const players = Array.from({ length: 5 }, () => crypto.randomUUID())
  const game = crypto.randomUUID()
  const token = crypto.randomUUID()
  const invocation = crypto.randomUUID()
  const tipoff = new Date(Date.now() + 600000).toISOString()
  const year = 20000 + crypto.getRandomValues(new Uint32Array(1))[0] % 100000
  let fixture: Fixture | undefined
  let runId: string | undefined
  try {
    fixture = JSON.parse(await sql(`BEGIN;
      \\i tests/db/rules-support.sql
      CREATE TEMP TABLE fixture AS SELECT * FROM pg_temp.rules_fixture(${teams},${year});
      DO $$ DECLARE f record; BEGIN
        SELECT * INTO f FROM fixture;
        UPDATE public.leagues SET roster_size=4 WHERE id=f.league_id;
        INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
          VALUES(${year},1,(now() AT TIME ZONE 'America/New_York')::date,(now() AT TIME ZONE 'America/New_York')::date);
        INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team)
          SELECT id,'Tipoff offer',id::text,'PG',ARRAY['PG'],'ZOF' FROM unnest(ARRAY[${players.map(id => `'${id}'::uuid`).join(',')}]) id;
        INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
          SELECT f.league_id,f.season_id,f.member_ids[CASE WHEN ordinal=1 THEN 1 WHEN ordinal=5 THEN 3 ELSE 2 END],id,'draft'
            FROM unnest(ARRAY[${players.map(id => `'${id}'::uuid`).join(',')}]) WITH ORDINALITY ids(id,ordinal);
        INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
          VALUES('${game}','owned-offer-${game}',${year},1,(now() AT TIME ZONE 'America/New_York')::date,'${tipoff}','ZOF','ZOA','Scheduled');
        DELETE FROM public.lineup_slot_templates WHERE league_id=f.league_id AND slot_type NOT IN ('PG','BE');
        UPDATE public.lineup_slot_templates SET slot_count=1 WHERE league_id=f.league_id AND slot_type='PG';
        UPDATE public.lineup_optimizer_settings SET enabled=true,last_optimized_at=now()+array_position(f.member_ids,member_id)*interval '1 second'
          WHERE league_id=f.league_id;
        PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
        ${pending ? `PERFORM public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY['${players[0]}'::uuid],ARRAY['${players[1]}'::uuid],'{}','{}');
        PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.locked_assets(f.league_id,f.season_id,f.member_ids[1]) WHERE asset_id='${players[0]}'),'pending offer reserves the player');
        PERFORM public.set_player_slot_atomic(f.member_ids[1],f.league_id,f.season_id,'${players[0]}',(now() AT TIME ZONE 'America/New_York')::date,'PG',1);
        PERFORM public.set_player_slot_atomic(f.member_ids[1],f.league_id,f.season_id,'${players[0]}',(now() AT TIME ZONE 'America/New_York')::date,'BE',1);` : ''}
        ${failMember ? 'UPDATE public.leagues SET roster_size=2 WHERE id=f.league_id;' : ''}
        INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until)
          VALUES('${tipoff}',(now() AT TIME ZONE 'America/New_York')::date,'queued','${token}',now()+interval '5 minutes');
        INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,invocation_key,payload,league_id)
          VALUES('pre-tipoff','owned-offer-${game}','running',1,'${token}',now()+interval '5 minutes','${invocation}',
            jsonb_build_object('mode','pre_tipoff','tipoffAt','${tipoff}'),f.league_id);
        INSERT INTO public.edge_invocations(function_name,invocation_key,work_item_id,work_lease_token)
          SELECT 'lineup-optimizer','${invocation}',id,'${token}' FROM private.work_items WHERE key='owned-offer-${game}';
      END $$;
      SELECT row_to_json(fixture) FROM fixture;
      COMMIT;`))
    assert.ok(fixture)
    const workId = await sql(`SELECT id FROM private.work_items WHERE key='owned-offer-${game}'`)
    const request = new Request(`${api}/functions/v1/lineup-optimizer`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-function-token': internalToken,
        'x-pancake-invocation-id': invocation, 'x-pancake-work-id': workId },
      body: JSON.stringify({ mode: 'pre_tipoff', tipoffAt: tipoff, token }),
    })
    const response: Response = await (edgeRuntime ? fetch(request) : handler(request))
    const bytes = await response.text()
    const result = JSON.parse(bytes)
    const state = JSON.parse(await sql(`SELECT jsonb_build_object(
      'work',(SELECT status FROM private.work_items WHERE id=${workId}),
      'attempts',(SELECT attempts FROM private.work_items WHERE id=${workId}),
      'dispatch',(SELECT status FROM public.lineup_tipoff_dispatches WHERE tipoff_at='${tipoff}'),
      'lineups',(SELECT jsonb_agg(member_id ORDER BY member_id) FROM public.weekly_lineups WHERE league_id='${fixture.league_id}'),
      'runId',(SELECT sync_run_id FROM public.edge_invocations WHERE invocation_key='${invocation}'),
      'run',(SELECT worker_status FROM public.edge_invocations WHERE invocation_key='${invocation}'))`))
    runId = state.runId
    assert.ok(state.lineups.includes(fixture.member_ids[0]), 'The pending-offer player must start')
    assert.ok(state.lineups.includes(fixture.member_ids[2]), 'A later healthy member must finish')
    console.log(JSON.stringify({ pending, failMember, teams, status: response.status, result, state }))
    assert.equal(response.status, 200, 'One member failure must not fail the batch')
    assert.equal(state.work, 'succeeded', 'One member failure must not retry the work item')
    assert.equal(state.dispatch, 'succeeded')
    assert.equal(state.run, 'success')
    assert.equal(state.attempts, 1)
    if (!failMember) {
      assert.equal(bytes, '{"ok":true,"optimized":3,"failed":0,"claimed":true,"errors":[]}')
    } else {
      assert.equal(result.ok, true)
      assert.equal(result.optimized, 2)
      assert.equal(result.failed, 1)
      assert.match(result.errors[0], /Roster is over the active player limit/)
      assert.ok(!state.lineups.includes(fixture.member_ids[1]), 'A failed member write must roll back')
      const members = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('member',member_id,'error',error)) FROM public.lineup_tipoff_members WHERE tipoff_at='${tipoff}'`))
      assert.equal(members.length, teams)
      assert.match(members.find((member: { member: string }) => member.member === fixture!.member_ids[1]).error, /Roster is over the active player limit/)
      assert.equal(members.filter((member: { error: string | null }) => member.error === null).length, teams - 1)
    }
  } finally {
    await sql(`BEGIN;
      DELETE FROM public.lineup_tipoff_members WHERE tipoff_at='${tipoff}';
      DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at='${tipoff}';
      DELETE FROM public.edge_invocations WHERE invocation_key='${invocation}';
      ${runId ? `DELETE FROM public.sync_runs WHERE id='${runId}';` : ''}
      ${fixture ? `DELETE FROM public.leagues WHERE id='${fixture.league_id}';
      DELETE FROM auth.users WHERE id=ANY(ARRAY[${fixture.user_ids.map(id => `'${id}'::uuid`).join(',')}]);` : ''}
      DELETE FROM public.nba_games WHERE id='${game}';
      DELETE FROM public.players WHERE id=ANY(ARRAY[${players.map(id => `'${id}'::uuid`).join(',')}]);
      DELETE FROM public.season_weeks WHERE season_year=${year};
      COMMIT;`)
  }
}
console.log(`${cases.length} pre-tipoff cases passed; owned fixtures removed`)

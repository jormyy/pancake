import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const db = new URL(Deno.env.get('SUPABASE_DB_URL')!)
const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
const workerPort = 8201
const workerOrigin = `http://host.docker.internal:${workerPort}`
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

const year = Number(await sql('SELECT COALESCE(max(season_year),9599)+1 FROM public.season_weeks'))
const today = await sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
const tipoff = new Date(Date.now() + 110_000).toISOString()
const team = 'Z' + randomUUID().slice(0, 2).toUpperCase()
const opponent = 'Y' + randomUUID().slice(0, 2).toUpperCase()
const lockedTeam = 'L' + randomUUID().slice(0, 2).toUpperCase()
const lockedOpponent = 'M' + randomUUID().slice(0, 2).toUpperCase()
const idleTeam = 'I' + randomUUID().slice(0, 2).toUpperCase()

type Fixture = {
  otherUser: string
  policyLeague: string; policySeason: string; unrelatedLeague: string; unrelatedSeason: string
  manualMember: string; optinMember: string; unrelatedMember: string
  manualHealthy: string; manualLocked: string; manualIneligible: string; manualInjured: string
  optinInjured: string; optinHealthy: string; unrelatedHealthy: string
  game: string; lockedGame: string
}

async function fixture(): Promise<Fixture> {
  const ids = Object.fromEntries(['user', 'otherUser', 'policyLeague', 'policySeason', 'unrelatedLeague', 'unrelatedSeason',
    'manualMember', 'optinMember', 'unrelatedMember', 'manualHealthy', 'manualLocked', 'manualIneligible', 'manualInjured',
    'optinInjured', 'optinHealthy', 'unrelatedHealthy', 'game', 'lockedGame'].map((key) => [key, randomUUID()])) as Record<string, string>
  await sql(`BEGIN;
    INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
      (${q(ids.user)},${q(ids.user + '@example.test')},'{}'),
      (${q(ids.otherUser)},${q(ids.otherUser + '@example.test')},'{}');
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,timezone,scoring_settings) VALUES
      (${q(ids.policyLeague)},'Policy',${q(ids.policyLeague)},${q(ids.user)},'active',20,1,'Pacific/Kiritimati','{"points":1}');
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES
      (${q(ids.policySeason)},${q(ids.policyLeague)},${year},true);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES
      (${q(ids.manualMember)},${q(ids.policyLeague)},${q(ids.user)},'commissioner','Manual');
    UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL WHERE league_id=${q(ids.policyLeague)} AND member_id=${q(ids.manualMember)};
    INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
      VALUES(${q(ids.policyLeague)},16,true,now(),now());
    DELETE FROM public.lineup_slot_templates WHERE league_id=${q(ids.policyLeague)} AND slot_type NOT IN ('PG','UTIL');
    INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES
      (${q(ids.policyLeague)},'PG',1),(${q(ids.policyLeague)},'UTIL',1)
      ON CONFLICT (league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,injury_status,injury_expected_return,nba_team) VALUES
      (${q(ids.manualHealthy)},'Manual','Healthy','PG',ARRAY['PG'],NULL,'unknown',${q(team)}),
      (${q(ids.manualLocked)},'Manual','Locked','PG',ARRAY['PG'],NULL,'unknown',${q(lockedTeam)}),
      (${q(ids.manualIneligible)},'Manual','Ineligible','C',ARRAY['C'],NULL,'unknown',${q(idleTeam)});
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES
      (${q(ids.policyLeague)},${q(ids.policySeason)},${q(ids.manualMember)},${q(ids.manualHealthy)},'draft'),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${q(ids.manualMember)},${q(ids.manualLocked)},'draft'),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${q(ids.manualMember)},${q(ids.manualIneligible)},'draft');
    INSERT INTO public.player_season_averages(league_id,league_season_id,season_year,player_id,averages,avg_fantasy_points,version) VALUES
      (${q(ids.policyLeague)},${q(ids.policySeason)},${year},${q(ids.manualHealthy)},'{}'::jsonb,20,1),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${year},${q(ids.manualLocked)},'{}'::jsonb,30,1),
      (${q(ids.policyLeague)},${q(ids.policySeason)},${year},${q(ids.manualIneligible)},'{}'::jsonb,40,1);
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
      VALUES(${year},1,${q(today)}::date-6,${q(today)}::date)
      ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES
      (${q(ids.game)},${q('002' + ids.game)},${year},1,${q(today)}::date,${q(tipoff)}::timestamptz,${q(team)},${q(opponent)},'Scheduled'),
      (${q(ids.lockedGame)},${q('003' + ids.lockedGame)},${year},1,${q(today)}::date,now()-interval '1 hour',${q(lockedTeam)},${q(lockedOpponent)},'In Progress');
    INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,slot_type,game_date,week_number,is_auto_set)
      VALUES(${q(ids.policyLeague)},${q(ids.policySeason)},${q(ids.manualMember)},${q(ids.manualLocked)},'PG',${q(today)}::date,1,false);
    COMMIT;`)
  return {
    otherUser: ids.otherUser,
    policyLeague: ids.policyLeague, policySeason: ids.policySeason,
    unrelatedLeague: ids.unrelatedLeague, unrelatedSeason: ids.unrelatedSeason,
    manualMember: ids.manualMember, optinMember: ids.optinMember, unrelatedMember: ids.unrelatedMember,
    manualHealthy: ids.manualHealthy, manualLocked: ids.manualLocked, manualIneligible: ids.manualIneligible,
    manualInjured: ids.manualInjured, optinInjured: ids.optinInjured, optinHealthy: ids.optinHealthy,
    unrelatedHealthy: ids.unrelatedHealthy, game: ids.game, lockedGame: ids.lockedGame,
  }
}

async function phaseTwo(f: Fixture) {
  await sql(`BEGIN;
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,timezone,scoring_settings) VALUES
      (${q(f.unrelatedLeague)},'Unrelated',${q(f.unrelatedLeague)},${q(f.otherUser)},'active',20,1,'Pacific/Kiritimati','{"points":1}');
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES
      (${q(f.unrelatedSeason)},${q(f.unrelatedLeague)},${year},true);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES
      (${q(f.optinMember)},${q(f.policyLeague)},${q(f.otherUser)},'manager','Optin'),
      (${q(f.unrelatedMember)},${q(f.unrelatedLeague)},${q(f.otherUser)},'commissioner','Unrelated');
    UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now() WHERE league_id=${q(f.policyLeague)} AND member_id=${q(f.optinMember)};
    UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now() WHERE league_id=${q(f.unrelatedLeague)} AND member_id=${q(f.unrelatedMember)};
    DELETE FROM public.lineup_slot_templates WHERE league_id=${q(f.unrelatedLeague)} AND slot_type NOT IN ('PG');
    INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES
      (${q(f.unrelatedLeague)},'PG',1)
      ON CONFLICT (league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,injury_status,injury_expected_return,nba_team) VALUES
      (${q(f.manualInjured)},'Manual','Injured','PG',ARRAY['PG'],'Out',${q(today)}::date+14,${q(team)}),
      (${q(f.optinInjured)},'Optin','Injured','PG',ARRAY['PG'],'Out',${q(today)}::date+14,${q(team)}),
      (${q(f.optinHealthy)},'Optin','Healthy','PG',ARRAY['PG'],NULL,'unknown',${q(team)}),
      (${q(f.unrelatedHealthy)},'Unrelated','Healthy','PG',ARRAY['PG'],NULL,'unknown',${q(team)});
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES
      (${q(f.policyLeague)},${q(f.policySeason)},${q(f.manualMember)},${q(f.manualInjured)},'draft'),
      (${q(f.policyLeague)},${q(f.policySeason)},${q(f.optinMember)},${q(f.optinInjured)},'draft'),
      (${q(f.policyLeague)},${q(f.policySeason)},${q(f.optinMember)},${q(f.optinHealthy)},'draft'),
      (${q(f.unrelatedLeague)},${q(f.unrelatedSeason)},${q(f.unrelatedMember)},${q(f.unrelatedHealthy)},'draft');
    INSERT INTO public.player_season_averages(league_id,league_season_id,season_year,player_id,averages,avg_fantasy_points,version) VALUES
      (${q(f.policyLeague)},${q(f.policySeason)},${year},${q(f.manualInjured)},'{}'::jsonb,10,1),
      (${q(f.policyLeague)},${q(f.policySeason)},${year},${q(f.optinInjured)},'{}'::jsonb,10,1),
      (${q(f.policyLeague)},${q(f.policySeason)},${year},${q(f.optinHealthy)},'{}'::jsonb,20,1),
      (${q(f.unrelatedLeague)},${q(f.unrelatedSeason)},${year},${q(f.unrelatedHealthy)},'{}'::jsonb,20,1);
    COMMIT;`)
}

async function cleanup(f: Fixture) {
  await sql(`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at=${q(tipoff)}::timestamptz;
    DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at=${q(tipoff)}::timestamptz;
    DELETE FROM private.work_items;
    DELETE FROM public.leagues WHERE id=ANY(ARRAY[${q(f.policyLeague)},${q(f.unrelatedLeague)}]::uuid[]);
    DELETE FROM public.nba_games WHERE id=ANY(ARRAY[${q(f.game)},${q(f.lockedGame)}]::uuid[]);
    DELETE FROM public.season_weeks WHERE season_year=${year};`)
}

async function waitForDispatch(scope: string, lease: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await sql(`SELECT status FROM public.lineup_tipoff_dispatches
      WHERE tipoff_at=${q(tipoff)}::timestamptz AND scope=${q(scope)} AND token=${q(lease)}`)
    if (status === 'succeeded' || status === 'failed') return status
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`dispatch ${scope} did not finish`)
}

async function dispatchAll(f: Fixture) {
  await sql(`SELECT private.enqueue_pre_tipoff_optimizer(now())`)
  const rows = (await sql(`SELECT id||'|'||lease_token||'|'||kind FROM private.work_claim(2)`)).split('\n').filter(Boolean)
  const items = rows.map((row) => {
    const [id, lease, kind] = row.split('|')
    return { id, lease, kind }
  })
  for (const item of items) {
    await sql(`BEGIN;
      SET LOCAL app.supabase_url=${q(workerOrigin)};
      SET LOCAL app.edge_internal_token=${q(token)};
      SELECT private.work_execute(${item.id},${q(item.lease)});
      COMMIT;`)
  }
  const results: Record<string, string> = {}
  for (const item of items) {
    const scope = item.kind === 'pre-tipoff-policy' ? f.policyLeague : ''
    results[item.kind] = await waitForDispatch(scope, item.lease)
  }
  return { items, results }
}

async function readback(f: Fixture) {
  const rows = await sql(`SELECT member_id||'|'||player_id||'|'||slot_type||'|'||is_auto_set
    FROM public.weekly_lineups WHERE league_id=${q(f.policyLeague)} ORDER BY member_id,slot_type`)
  const ir = await sql(`SELECT player_id FROM public.roster_players
    WHERE league_id=${q(f.policyLeague)} AND is_on_ir ORDER BY player_id`)
  const members = await sql(`SELECT member_id||'|'||input_revision||'|'||coalesce(to_jsonb(m)->>'ir_done','')||'|'||coalesce(to_jsonb(m)->>'starter_done','')||'|'||coalesce(error,'')
    FROM public.lineup_tipoff_members m WHERE tipoff_at=${q(tipoff)}::timestamptz ORDER BY member_id,input_revision`)
  const unrelated = await sql(`SELECT count(*) FROM public.weekly_lineups WHERE league_id=${q(f.unrelatedLeague)}`)
  return { rows, ir, members, unrelated }
}

async function workCount() {
  return Number(await sql(`SELECT count(*) FROM private.work_items WHERE kind IN ('pre-tipoff','pre-tipoff-policy')`))
}

async function fingerprint() {
  return sql(`SELECT private.pre_tipoff_policy_input_fingerprint(${q(today)}::date, ${q(f.policyLeague)})`)
}

const workerEntry = Deno.env.get('R7_WORKER_ENTRY') ?? new URL('../../supabase/functions/lineup-optimizer/index.ts', import.meta.url).pathname
const worker = new Deno.Command('deno', {
  args: ['run', '--allow-all', new URL('./r5b-serve.mts', import.meta.url).pathname],
  env: { ...Deno.env.toObject(), R5B_PORT: String(workerPort), R5B_ENTRY: workerEntry },
  stdout: 'null', stderr: 'inherit',
}).spawn()

for (let attempt = 0; attempt < 300; attempt += 1) {
  try {
    const connection = await Deno.connect({ hostname: '127.0.0.1', port: workerPort })
    connection.close()
    break
  } catch {
    if (attempt === 299) throw new Error('worker did not start')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const f = await fixture()
const summary: Record<string, unknown> = {}
try {
  const first = await dispatchAll(f)
  const afterFirst = await readback(f)
  summary.first = { results: first.results, ...afterFirst }
  assert.equal(first.results['pre-tipoff-policy'], 'succeeded', 'first policy dispatch')
  assert.equal(afterFirst.ir, '', 'first IR-only pass is a genuine no-op')
  assert.doesNotMatch(afterFirst.rows, new RegExp(f.manualHealthy), 'no starter before Auto Lineup is on')
  assert.match(afterFirst.rows, new RegExp(`${f.manualLocked}\\|PG\\|f`), 'locked starter is unchanged by the IR-only pass')
  assert.doesNotMatch(afterFirst.rows, new RegExp(f.manualIneligible), 'ineligible player did not start')
  assert.equal(afterFirst.unrelated, '0', 'no unrelated league starter yet')

  const before = await fingerprint()
  await sql(`UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now()
    WHERE league_id=${q(f.policyLeague)} AND member_id=${q(f.manualMember)}`)
  const enabled = await fingerprint()
  await sql(`UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL
    WHERE league_id=${q(f.policyLeague)} AND member_id=${q(f.manualMember)}`)
  const restored = await fingerprint()
  await sql(`UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now()
    WHERE league_id=${q(f.policyLeague)} AND member_id=${q(f.manualMember)}`)
  summary.fingerprint = { before, enabled, restored }
  assert.equal(restored, before, 'fingerprint inputs other than the Auto Lineup setting are unchanged')

  const second = await dispatchAll(f)
  const afterSecond = await readback(f)
  summary.second = { results: second.results, ...afterSecond }
  assert.match(afterSecond.rows, new RegExp(`${f.manualHealthy}\\|UTIL\\|t`), 'eligible unlocked starter is set after Auto Lineup is enabled')
  assert.match(afterSecond.rows, new RegExp(`${f.manualLocked}\\|PG\\|f`), 'locked starter is unchanged')
  assert.doesNotMatch(afterSecond.rows, new RegExp(f.manualIneligible), 'ineligible player did not start')
  assert.equal(afterSecond.ir, '', 'enabling Auto Lineup alone makes no IR move')
  assert.equal(second.results['pre-tipoff-policy'], 'succeeded', 'second policy dispatch')
  const flags = await sql(`SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='lineup_tipoff_members' AND column_name IN ('ir_done','starter_done')`)
  if (flags === '2') {
    assert.match(afterSecond.members, new RegExp(`${f.manualMember}\\|1\\|true\\|false\\|`), 'IR-only receipt at revision 1')
    assert.match(afterSecond.members, new RegExp(`${f.manualMember}\\|2\\|false\\|true\\|`), 'starter receipt at revision 2')
  }

  await phaseTwo(f)
  await sql(`CREATE OR REPLACE FUNCTION public.r7_disable_on_ir() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.is_on_ir AND NOT OLD.is_on_ir AND NEW.league_id=${q(f.policyLeague)}::uuid AND NEW.member_id=${q(f.optinMember)}::uuid THEN
        UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL
         WHERE league_id=NEW.league_id AND member_id=NEW.member_id;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS r7_disable_on_ir ON public.roster_players;
    CREATE TRIGGER r7_disable_on_ir AFTER UPDATE OF is_on_ir ON public.roster_players
      FOR EACH ROW EXECUTE FUNCTION public.r7_disable_on_ir();`)

  const third = await dispatchAll(f)
  const afterThird = await readback(f)
  summary.third = { results: third.results, ...afterThird }
  assert.equal(third.results['pre-tipoff-policy'], 'succeeded', 'phase-two policy dispatch')
  assert.equal(third.results['pre-tipoff'], 'succeeded', 'phase-two shared dispatch')
  assert.match(afterThird.ir, new RegExp(f.manualInjured), 'manual injured player moved to IR')
  assert.match(afterThird.ir, new RegExp(f.optinInjured), 'optin injured player moved to IR')
  assert.equal(await sql(`SELECT enabled FROM public.lineup_optimizer_settings WHERE league_id=${q(f.policyLeague)} AND member_id=${q(f.optinMember)}`), 'f', 'off-during-processing member is disabled')
  assert.doesNotMatch(afterThird.rows, new RegExp(f.optinHealthy), 'off-during-processing member wrote no starter')
  assert.equal(afterThird.unrelated, '1', 'unrelated league keeps its starter write')
  assert.match(afterThird.rows, new RegExp(`${f.manualHealthy}\\|UTIL\\|t`), 'manual starter survives the phase-two IR move')
  assert.match(afterThird.rows, new RegExp(`${f.manualLocked}\\|PG\\|f`), 'locked starter survives the phase-two IR move')
  assert.doesNotMatch(afterThird.rows, new RegExp(f.manualIneligible), 'ineligible player still did not start')

  const settle = await dispatchAll(f)
  const afterSettle = await readback(f)
  summary.settle = { results: settle.results, ...afterSettle }
  assert.equal(settle.results['pre-tipoff-policy'], 'succeeded', 'settle policy dispatch')
  assert.equal(settle.results['pre-tipoff'], undefined, 'settle pass leaves the shared scope closed')
  assert.equal(afterSettle.rows, afterThird.rows, 'settle pass leaves slots byte-identical')
  assert.equal(afterSettle.ir, afterThird.ir, 'settle pass makes no second IR move')

  const beforeRetry = afterSettle.rows
  const workBefore = await workCount()
  const retry = await dispatchAll(f)
  const afterRetry = await readback(f)
  summary.retry = { results: retry.results, items: retry.items.length, ...afterRetry }
  assert.equal(retry.items.length, 0, 'mode-unchanged retry enqueues no work')
  assert.equal(await workCount(), workBefore, 'mode-unchanged retry leaves no new work item')
  assert.equal(afterRetry.rows, beforeRetry, 'mode-unchanged retry leaves slots byte-identical')
  assert.equal(afterRetry.ir, afterSettle.ir, 'mode-unchanged retry makes no second IR move')

  const oldPolicyToken = first.items.find((item) => item.kind === 'pre-tipoff-policy')!.lease
  const newPolicyToken = settle.items.find((item) => item.kind === 'pre-tipoff-policy')!.lease
  const delayed = await sql(`SELECT coalesce(public.claim_lineup_tipoff_dispatch(${q(tipoff)}::timestamptz,${q(oldPolicyToken)},${q(f.policyLeague)})::text,'null')`)
  summary.delayed = delayed
  assert.equal(delayed, 'null', 'previous revision token cannot claim the current dispatch')
  const unscoped = await sql(`DO $$ BEGIN
    PERFORM public.claim_lineup_tipoff_dispatch(${q(tipoff)}::timestamptz,${q(newPolicyToken)});
    RAISE EXCEPTION 'unscoped claim unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'PT409' THEN RAISE; END IF;
  END $$; SELECT 'PT409'`)
  summary.unscoped = unscoped
  assert.equal(unscoped, 'PT409', 'older worker unscoped claim is refused')
  assert.equal(await sql(`SELECT count(*) FROM public.weekly_lineups WHERE league_id=${q(f.policyLeague)} AND member_id=${q(f.manualMember)}`), '2', 'official league has exactly the locked and eligible starters')
  console.log(JSON.stringify(summary, null, 2))
} finally {
  console.log(JSON.stringify(summary, null, 2))
  await sql(`DROP TRIGGER IF EXISTS r7_disable_on_ir ON public.roster_players; DROP FUNCTION IF EXISTS public.r7_disable_on_ir();`)
  await cleanup(f)
  worker.kill()
}

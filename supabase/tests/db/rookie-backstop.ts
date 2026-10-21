import assert from 'node:assert/strict'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const target of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
assert.equal(new URL(api).port, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321')
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
const { runSeasonBoundary } = await import('../../functions/_shared/seasonBoundary.ts')
const sql = async (statement: string): Promise<string> => {
  const result = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = result.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const output = await result.output()
  assert.equal(output.code, 0, new TextDecoder().decode(output.stderr))
  return new TextDecoder().decode(output.stdout).trim()
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const failures: string[] = []
const cases = ['in_progress', 'paused', 'mock', 'auction', 'commissioner_early', 'mock_resume', 'missing']
const selectedCase = Deno.env.get('POST_ROOKIE_CASE')
assert.ok(!selectedCase || cases.includes(selectedCase))
for (const state of cases.filter(value => !selectedCase || value === selectedCase)) {
  const league = crypto.randomUUID(), season = crypto.randomUUID()
  const users = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const members = users.map(() => crypto.randomUUID())
  const players = Array.from({ length: 12 }, () => crypto.randomUUID())
  const year = 8831 + cases.indexOf(state)
  try {
    await sql(`BEGIN;
      ${users.map(user => `INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES(${quote(user)},'authenticated','authenticated',${quote(user+'@example.test')},'x',now(),'{}','{}',now(),now());`).join('\n')}
      INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week) VALUES(${quote(league)},'Synthetic rookie recovery',${quote(league)},${quote(users[0])},'${state === 'auction' ? 'setup' : 'offseason'}',${state === 'mock' || state === 'auction' ? 2 : 1});
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},${year},true);
      ${members.map((member, index) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(member)},${quote(league)},${quote(users[index])},'${index===0?'commissioner':'manager'}','Team ${index}');`).join('\n')}
      INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id) SELECT ${quote(league)},${year},r,m,m FROM unnest(ARRAY[${members.map(quote).join(',')}]::uuid[]) m CROSS JOIN generate_series(1,3) r;
      INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT ${year},w,date '2026-10-20'+(w-1)*7,date '2026-10-26'+(w-1)*7 FROM generate_series(1,3) w;
      ${players.map(player => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) VALUES(${quote(player)},'Synthetic',${quote(player)},'PG',ARRAY['PG'],0,1);`).join('\n')}
      ${state === 'missing' ? '' : state === 'auction' ? `SELECT start_auction_draft_atomic(${quote(league)});` : `SELECT start_rookie_draft_atomic(${quote(league)},3,false);`}
      ${['mock', 'mock_resume'].includes(state) ? `UPDATE drafts SET is_mock=true WHERE league_id=${quote(league)};` : ''}
      ${state === 'paused' ? `UPDATE drafts SET status='paused',pause_reason='timer_expired_pause' WHERE league_id=${quote(league)};` : ''}
      ${['commissioner_early', 'mock_resume'].includes(state) ? `SELECT pause_draft_atomic((SELECT id FROM drafts WHERE league_id=${quote(league)}),${quote(users[0])});` : ''}
      ${['in_progress', 'paused', 'mock'].includes(state) ? `UPDATE snake_draft_picks SET timer_expires_at=now()-interval '1 minute' WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${quote(league)}) AND overall_pick=1;` : ''}
      COMMIT;`)
    const snapshot = () => sql(`SELECT jsonb_build_object(
      'league',(SELECT to_jsonb(l) FROM leagues l WHERE id=${quote(league)}),
      'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d WHERE league_id=${quote(league)}),
      'picks',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM snake_draft_picks p JOIN drafts d ON d.id=p.draft_id WHERE d.league_id=${quote(league)}),
      'audit',(SELECT count(*) FROM draft_audit_logs WHERE league_id=${quote(league)}));`)
    if (state === 'mock_resume') {
      const before = await snapshot()
      await sql(`DO $test$ DECLARE message text; BEGIN
        BEGIN PERFORM auto_pick_snake_pick_atomic((SELECT id FROM drafts WHERE league_id=${quote(league)}),
          (SELECT member_id FROM snake_draft_picks WHERE draft_id=(SELECT id FROM drafts WHERE league_id=${quote(league)}) ORDER BY overall_pick LIMIT 1),'season_boundary_backstop');
        EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
        IF message IS DISTINCT FROM 'Draft is not in progress' THEN RAISE EXCEPTION 'Paused mock must reject backstop auto-pick, got %',message; END IF;
      END $test$;`)
      assert.equal(await snapshot(), before)
      console.log('PASS a direct backstop RPC never resumes a paused mock draft')
      continue
    }
    if (state === 'auction') {
      const before = await snapshot()
      const report = await runSeasonBoundary(new Date('2026-10-20T04:00:00Z'), league)
      assert.ok(report.every(item => !item.error && item.actions.length === 0))
      assert.equal(await snapshot(), before)
      assert.equal(await sql(`SELECT count(*) FROM drafts WHERE league_id=${quote(league)} AND draft_type='snake'`), '0')
      assert.equal(await sql(`SELECT count(*) FROM snake_draft_picks WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${quote(league)})`), '0')
      assert.equal(await sql(`SELECT status FROM leagues WHERE id=${quote(league)}`), 'drafting')
      console.log('PASS a real auction startup after week one stays untouched')
      continue
    }
    const beforeEarly = await snapshot()
    const early = await runSeasonBoundary(new Date('2026-10-20T03:59:59Z'), league)
    assert.ok(early.every(report => !report.error))
    assert.equal(await snapshot(), beforeEarly)
    if (state === 'commissioner_early') {
      assert.equal(await sql(`SELECT status||':'||pause_reason FROM drafts WHERE league_id=${quote(league)}`), 'paused:manual')
      console.log('PASS a commissioner-paused rookie draft stays paused before week one')
      continue
    }
    assert.equal(await sql(`SELECT count(*) FROM snake_draft_picks WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${quote(league)}) AND player_id IS NOT NULL`), '0')
    const due = await runSeasonBoundary(new Date('2026-10-20T04:00:00Z'), league)
    console.log(JSON.stringify({ provenance: 'SYNTHETIC', state, due }))
    if (state === 'mock') {
      assert.equal(due[0]?.error, undefined)
      assert.deepEqual(due[0]?.actions, [])
      assert.equal(await sql(`SELECT count(*) FROM matchups WHERE league_season_id=${quote(season)}`), '0')
      assert.equal(await sql(`SELECT count(*) FROM snake_draft_picks WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${quote(league)}) AND player_id IS NOT NULL`), '0')
      console.log('PASS a mock draft does not start a real draft or generate a schedule')
      continue
    }
    assert.equal(due.length, 1, 'A real drafting league must reach the rookie backstop')
    assert.equal(due[0].error, undefined)
    assert.ok(due[0].actions.includes('rookie-draft-auto-completed'))
    assert.equal(await sql(`SELECT count(*) FROM snake_draft_picks WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${quote(league)}) AND player_id IS NOT NULL`), '12')
    if (state === 'missing') assert.equal(await sql(`SELECT pick_timer_seconds FROM drafts WHERE league_id=${quote(league)}`), '60', 'The boundary must use the supported rookie timer minimum')
    const repeated = await runSeasonBoundary(new Date('2026-10-20T04:00:01Z'), league)
    assert.ok(repeated.every(report => !report.error))
    assert.equal(await sql(`SELECT count(*) FROM drafts WHERE league_id=${quote(league)}`), '1')
    console.log(`PASS ${state} rookie backstop completes every pick and retries safely`)
  } catch (error) {
    failures.push(`${state}: ${(error as Error).message}`)
  } finally {
    await sql(`BEGIN;
      DELETE FROM snake_draft_picks WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${quote(league)});
      DELETE FROM draft_picks WHERE league_id=${quote(league)};
      DELETE FROM drafts WHERE league_id=${quote(league)};
      DELETE FROM leagues WHERE id=${quote(league)};
      DELETE FROM players WHERE id IN(${players.map(quote).join(',')});
      DELETE FROM season_weeks WHERE season_year=${year};
      DELETE FROM auth.users WHERE id IN(${users.map(quote).join(',')});
      COMMIT;`)
  }
}
assert.deepEqual(failures, [])

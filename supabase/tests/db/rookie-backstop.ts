import assert from 'node:assert/strict'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const target of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
assert.equal(new URL(api).port, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '57421')
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '57422')
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
for (const state of ['in_progress', 'paused', 'mock']) {
  const league = crypto.randomUUID(), season = crypto.randomUUID()
  const users = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const members = users.map(() => crypto.randomUUID())
  const players = Array.from({ length: 12 }, () => crypto.randomUUID())
  const year = state === 'paused' ? 8832 : state === 'mock' ? 8833 : 8831
  try {
    await sql(`BEGIN;
      ${users.map(user => `INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES(${quote(user)},'authenticated','authenticated',${quote(user+'@example.test')},'x',now(),'{}','{}',now(),now());`).join('\n')}
      INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week) VALUES(${quote(league)},'Synthetic rookie recovery',${quote(league)},${quote(users[0])},'offseason',${state === 'mock' ? 2 : 1});
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},${year},true);
      ${members.map((member, index) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(member)},${quote(league)},${quote(users[index])},'${index===0?'commissioner':'manager'}','Team ${index}');`).join('\n')}
      INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id) SELECT ${quote(league)},${year},r,m,m FROM unnest(ARRAY[${members.map(quote).join(',')}]::uuid[]) m CROSS JOIN generate_series(1,3) r;
      INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT ${year},w,date '2026-10-20'+(w-1)*7,date '2026-10-26'+(w-1)*7 FROM generate_series(1,3) w;
      ${players.map(player => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) VALUES(${quote(player)},'Synthetic',${quote(player)},'PG',ARRAY['PG'],0,1);`).join('\n')}
      SELECT start_rookie_draft_atomic(${quote(league)},3,false);
      UPDATE drafts SET is_mock=${state === 'mock'},status=${quote(state === 'mock' ? 'in_progress' : state)},pause_reason=${state==='paused'?"'timer_expired_pause'":'NULL'} WHERE league_id=${quote(league)};
      UPDATE snake_draft_picks SET timer_expires_at=now()-interval '1 minute' WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${quote(league)}) AND overall_pick=1;
      COMMIT;`)
    const early = await runSeasonBoundary(new Date('2026-10-20T03:59:59Z'), league)
    assert.ok(early.every(report => !report.error))
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

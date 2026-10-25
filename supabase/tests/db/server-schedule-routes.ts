import assert from 'node:assert/strict'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'

export async function verifyScheduleRoutes() {
  const api = Deno.env.get('SUPABASE_URL')!
  const db = Deno.env.get('SUPABASE_DB_URL')!
  for (const [value, port] of [[api, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321'], [db, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322']]) {
    const url = new URL(value)
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === port)
  }
  const admin = createClient(api, Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  const client = createClient(api, Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  const league = crypto.randomUUID(), season = crypto.randomUUID()
  const year = 25961
  const users: string[] = []
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  async function sql(statement: string) {
    const result = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1', '-c', statement], stdin: 'null', stdout: 'piped', stderr: 'piped' }).output()
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
    return new TextDecoder().decode(result.stdout).trim()
  }
  let checks = 0
  let ownsCalendar = false
  const failures: string[] = []
  const previousSecret = Deno.env.get('E2E_ADMIN_SECRET')
  Deno.env.set('E2E_ADMIN_SECRET', crypto.randomUUID())
  try {
    assert.equal(await sql(`SELECT count(*) FROM season_weeks WHERE season_year=${year}`), '0')
    const password = crypto.randomUUID()
    const email = `${crypto.randomUUID()}@example.test`
    for (const address of [email, `${crypto.randomUUID()}@example.test`]) {
      const created = await admin.auth.admin.createUser({ email: address, password, email_confirm: true })
      assert.equal(created.error, null)
      users.push(created.data.user!.id)
    }
    const signed = await client.auth.signInWithPassword({ email, password })
    assert.equal(signed.error, null)
    const token = signed.data.session!.access_token
    await sql(`BEGIN;
      INSERT INTO leagues(id,name,slug,commissioner_id,status)
        VALUES(${quote(league)},'Schedule routes',${quote(league)},${quote(users[0])},'setup');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},${year},true);
      ${users.map((id, index) => `INSERT INTO league_members(league_id,user_id,role,team_name) VALUES(${quote(league)},${quote(id)},'${index ? 'manager' : 'commissioner'}','Schedule ${index}');`).join('\n')}
      INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
        SELECT ${year},n,(now() AT TIME ZONE 'America/New_York')::date+14+(n-1)*7,(now() AT TIME ZONE 'America/New_York')::date+20+(n-1)*7 FROM generate_series(1,24) n;
      INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
        SELECT '002-route-'||${quote(league)}||n,${year},n,(now() AT TIME ZONE 'America/New_York')::date+14+(n-1)*7,'RTE','SCH','Scheduled' FROM generate_series(1,24) n;
      COMMIT;`)
    ownsCalendar = true
    const { handleApiRoute } = await import('../../functions/api/router.ts')
    for (const path of ['/sync/matchups', '/e2e/generate-matchups']) {
      await sql(`DELETE FROM matchups WHERE league_season_id=${quote(season)};
        UPDATE season_weeks SET week_start=(now() AT TIME ZONE 'America/New_York')::date+14 WHERE season_year=${year} AND week_number=1;`)
      const ids = () => sql(`SELECT jsonb_agg(id ORDER BY id) FROM matchups WHERE league_season_id=${quote(season)}`)
      const call = (force: boolean) => handleApiRoute(new Request(`${api}/functions/v1/api${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-e2e-secret': Deno.env.get('E2E_ADMIN_SECRET')! },
        body: JSON.stringify({ leagueId: league, force }),
      }))
      for (const force of [false, true]) {
        const previous = await ids()
        const response = await call(force)
        assert.equal(response.status, 200, `${path} before the first week starts`)
        assert.deepEqual(await response.json(), { ok: true })
        assert.equal(await sql(`SELECT count(*) FROM matchups WHERE league_season_id=${quote(season)}`), '19')
        assert.notEqual(await ids(), previous)
        checks += 4
      }
      const scheduled = await ids()
      const skipped = await call(false)
      assert.equal(skipped.status, 200, `${path} existing schedule before week one`)
      assert.deepEqual(await skipped.json(), { ok: true, skipped: true })
      assert.equal(await ids(), scheduled)
      checks += 3
      await sql(`UPDATE season_weeks SET week_start=(now() AT TIME ZONE 'America/New_York')::date WHERE season_year=${year} AND week_number=1;`)
      const previous = await ids()
      for (const force of [false, true]) {
        const response = await call(force)
        const body = await response.json()
        try {
          assert.equal(response.status, force ? 409 : 200, `${path} after the first scheduled week starts, force=${force}`)
          assert.deepEqual(body, force ? { error: 'The season has started; the schedule can no longer be rebuilt.' } : { ok: true, skipped: true })
        } catch (error) { failures.push(`${path}, force=${force}: ${(error as Error).message}`) }
        assert.equal(await ids(), previous)
        checks += 3
      }
    }
    assert.deepEqual(failures, [])
    console.log(JSON.stringify({ passed: checks, routes: 2, realDatabase: true, firstWeekStarted: true }))
  } finally {
    await sql(`DELETE FROM leagues WHERE id=${quote(league)};
      DELETE FROM nba_games WHERE nba_game_id LIKE '002-route-'||${quote(league)}||'%';
      DELETE FROM season_weeks WHERE season_year=${year} AND ${ownsCalendar};`)
    for (const user of users) assert.equal((await admin.auth.admin.deleteUser(user)).error, null)
    await client.auth.signOut()
    if (previousSecret === undefined) Deno.env.delete('E2E_ADMIN_SECRET')
    else Deno.env.set('E2E_ADMIN_SECRET', previousSecret)
  }
}

if (import.meta.main) await verifyScheduleRoutes()

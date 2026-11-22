import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function query(sql, appName) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: appName ? { ...process.env, PGAPPNAME: appName } : process.env,
    })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output: output.trim(), error }))
  })
}

const one = async (sql) => {
  const result = await query(sql)
  assert.equal(result.code, 0, result.error)
  return result.output
}

const pickYear = async (exclude = []) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const year = 9000 + Math.floor(Math.random() * 1000)
    if (exclude.includes(year)) continue
    if (await one(`SELECT count(*) FROM public.season_weeks WHERE season_year = ${year}`) === '0') return year
  }
  throw new Error('Could not find an unused season year')
}

const setup = async (year, { counts = [15, 16, 16], freeAgentCount = 2 } = {}) => {
  const league = randomUUID()
  const season = randomUUID()
  const users = [randomUUID(), randomUUID(), randomUUID()]
  const members = [randomUUID(), randomUUID(), randomUUID()]
  const freeAgents = Array.from({ length: freeAgentCount }, () => randomUUID())
  const players = [...freeAgents]
  const weekEnd = await one(`SELECT (now() AT TIME ZONE 'America/New_York')::date`)
  const statements = [
    `INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ${users.map((user) => `(${quote(user)}, 'authenticated', 'authenticated', ${quote(`${user}@example.test`)}, 'x', now(), '{}', '{}', now(), now())`).join(',')}`,
    `INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, timezone)
     VALUES (${quote(league)}, 'Floor membership', ${quote(league)}, ${quote(users[0])}, 'active', 20, 'Pacific/Kiritimati')`,
    `INSERT INTO public.league_seasons(id, league_id, season_year, is_current) VALUES (${quote(season)}, ${quote(league)}, ${year}, true)`,
    `INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
     VALUES ${members.map((member, index) => `(${quote(member)}, ${quote(league)}, ${quote(users[index])}, ${quote(index === 0 ? 'commissioner' : 'manager')}, ${quote(`Floor team ${index + 1}`)})`).join(',')}`,
    `INSERT INTO public.waiver_priorities(league_id, league_season_id, member_id, priority)
     VALUES ${members.map((member, index) => `(${quote(league)}, ${quote(season)}, ${quote(member)}, ${index + 1})`).join(',')}`,
    `INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
     VALUES (${quote(league)}, 16, true, now(), now())`,
    `INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
     SELECT ${quote(league)}, ${quote(season)}, true, league.scoring_settings
       FROM public.leagues league WHERE league.id = ${quote(league)}
     ON CONFLICT (league_season_id) DO UPDATE
       SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring`,
    `INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES (${quote(league)}, ${quote(season)}, ${quote(weekEnd)}::date)`,
    `INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
     VALUES (${year}, 1, ${quote(weekEnd)}::date - 6, ${quote(weekEnd)}::date)`,
    `INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
     VALUES (${quote(league)}, ${quote(season)}, 1, ${quote(members[0])}, ${quote(members[1])})`,
    `INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, team_order, status)
     VALUES (${quote(league)}, ${quote(season)}, 1, ${quote(weekEnd)}::date, ARRAY[${members.map(quote).join(',')}]::uuid[], 'pending')`,
  ]
  for (const [index, member] of members.entries()) {
    for (let slot = 0; slot < counts[index]; slot += 1) {
      const player = randomUUID()
      players.push(player)
      statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
        VALUES (${quote(player)}, ${quote(player)}, 'Roster${index}${slot}', 'Test', 'PG', ARRAY['PG'], 'Healthy', 'ZZ')`)
      statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
        VALUES (${quote(league)}, ${quote(season)}, ${quote(member)}, ${quote(player)}, 'draft')`)
    }
  }
  for (const [index, player] of freeAgents.entries()) {
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Free${index}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
    statements.push(`INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
      VALUES (${quote(league)}, ${quote(season)}, ${year}, ${quote(player)}, '{}'::jsonb, ${40 - index * 10}, 1)`)
  }
  statements.push(`INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, clears_at)
    SELECT ${quote(league)}, ${quote(season)}, player.id, now() + interval '1 day'
      FROM public.players player
     WHERE NOT (player.id = ANY(ARRAY[${freeAgents.map(quote).join(',')}]::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM public.roster_players roster
         WHERE roster.league_id = ${quote(league)} AND roster.league_season_id = ${quote(season)} AND roster.player_id = player.id)`)
  await one(`BEGIN; ${statements.join('; ')}; COMMIT;`)
  return { league, season, members, freeAgents, players, users }
}

const removalSql = (fixture, member) => `
  DELETE FROM public.roster_players WHERE league_id = ${quote(fixture.league)} AND league_season_id = ${quote(fixture.season)} AND member_id = ${quote(member)};
  DELETE FROM public.waiver_priorities WHERE league_id = ${quote(fixture.league)} AND league_season_id = ${quote(fixture.season)} AND member_id = ${quote(member)};
  DELETE FROM public.matchups WHERE league_id = ${quote(fixture.league)} AND league_season_id = ${quote(fixture.season)} AND (home_member_id = ${quote(member)} OR away_member_id = ${quote(member)});
  DELETE FROM public.league_members WHERE id = ${quote(member)} AND league_id = ${quote(fixture.league)};`

const cleanup = async (fixture, year) => {
  await one(`DELETE FROM public.leagues WHERE id = ${quote(fixture.league)}`)
  await one(`DELETE FROM public.players WHERE id = ANY(ARRAY[${fixture.players.map(quote).join(',')}]::uuid[])`)
  await one(`DELETE FROM auth.users WHERE id = ANY(ARRAY[${fixture.users.map(quote).join(',')}]::uuid[])`)
  await one(`DELETE FROM public.season_weeks WHERE season_year = ${year} AND week_number = 1`)
  const leftover = await one(`SELECT (SELECT count(*) FROM public.leagues WHERE id = ${quote(fixture.league)})
    + (SELECT count(*) FROM public.players WHERE id = ANY(ARRAY[${fixture.players.map(quote).join(',')}]::uuid[]))
    + (SELECT count(*) FROM auth.users WHERE id = ANY(ARRAY[${fixture.users.map(quote).join(',')}]::uuid[]))
    + (SELECT count(*) FROM public.season_weeks WHERE season_year = ${year} AND week_number = 1)`)
  assert.equal(leftover, '0', 'The membership fixtures were not fully removed.')
}

const removalHeld = async () => (await one(`SELECT NOT pg_try_advisory_xact_lock(hashtext('membership-removal'))`)) === 't'
const floorHeld = async () => (await one(`SELECT NOT pg_try_advisory_xact_lock(hashtext('membership-floor-hold'))`)) === 't'
const floorWaiting = async () => (await one(`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'floor-membership' AND wait_event_type = 'Lock'`)) !== '0'

const runRemovalFirst = async (year) => {
  const fixture = await setup(year)
  try {
    const removal = query(`BEGIN; ${removalSql(fixture, fixture.members[2])} SELECT pg_advisory_xact_lock(hashtext('membership-removal')); SELECT pg_sleep(4); COMMIT;`)
    for (let attempt = 0; attempt < 50 && !(await removalHeld()); attempt += 1) await sleep(100)
    assert(await removalHeld(), 'The removal transaction did not reach its hold.')
    const floor = query(`SELECT public.process_roster_floor_service(${quote(fixture.league)}, ${quote(fixture.season)})`, 'floor-membership')
    for (let attempt = 0; attempt < 50 && !(await floorWaiting()); attempt += 1) await sleep(100)
    assert(await floorWaiting(), 'The floor did not wait for the uncommitted removal.')
    const [removed, result] = await Promise.all([removal, floor])
    assert.equal(removed.code, 0, removed.error)
    assert.equal(result.code, 0, result.error)
    const parsed = JSON.parse(result.output)
    console.log(JSON.stringify({ removalFirst: parsed }))
    assert.equal(parsed.status, 'completed', 'The floor did not complete after the removal committed.')
    assert.equal(parsed.awarded, 1, 'The floor awarded the wrong number of players.')
    const award = await one(`SELECT member_id FROM private.roster_floor_awards WHERE league_id = ${quote(fixture.league)} AND player_id = ${quote(fixture.freeAgents[0])}`)
    assert.equal(award, fixture.members[0], 'The surviving stored team did not get the best player.')
    const order = await one(`SELECT array_to_string(team_order, ',') FROM private.roster_floor_weeks WHERE league_id = ${quote(fixture.league)}`)
    assert.equal(order, `${fixture.members[0]},${fixture.members[1]}`, 'The stored order did not drop the departed member.')
    const departed = await one(`SELECT count(*) FROM private.roster_floor_awards WHERE league_id = ${quote(fixture.league)} AND member_id = ${quote(fixture.members[2])}`)
    assert.equal(departed, '0', 'The departed member was awarded.')
    return { parsed, order }
  } finally {
    await cleanup(fixture, year)
  }
}

const runFloorFirst = async (year) => {
  const fixture = await setup(year, { counts: [15, 16, 0], freeAgentCount: 1 })
  try {
    const floor = query(`BEGIN; SELECT public.process_roster_floor_service(${quote(fixture.league)}, ${quote(fixture.season)}); SELECT pg_advisory_xact_lock(hashtext('membership-floor-hold')); SELECT pg_sleep(4); COMMIT;`, 'floor-hold')
    for (let attempt = 0; attempt < 50 && !(await floorHeld()); attempt += 1) await sleep(100)
    assert(await floorHeld(), 'The floor transaction did not reach its hold.')
    const blocked = await query(`BEGIN; SET LOCAL statement_timeout = '1s'; ${removalSql(fixture, fixture.members[2])} COMMIT;`)
    assert.notEqual(blocked.code, 0, 'The member delete did not wait for the open floor transaction.')
    assert.match(blocked.error, /statement timeout|canceling statement/i, 'The member delete failed for an unexpected reason.')
    const [held, removed] = await Promise.all([floor, query(`BEGIN; ${removalSql(fixture, fixture.members[2])} COMMIT;`)])
    assert.equal(held.code, 0, held.error)
    assert.equal(removed.code, 0, removed.error)
    const parsed = JSON.parse(held.output.split('\n')[0])
    console.log(JSON.stringify({ floorFirst: parsed }))
    assert.equal(parsed.status, 'completed', 'The floor did not complete.')
    assert.equal(parsed.awarded, 1, 'The floor awarded the wrong number of players.')
    const award = await one(`SELECT member_id FROM private.roster_floor_awards WHERE league_id = ${quote(fixture.league)} AND player_id = ${quote(fixture.freeAgents[0])}`)
    assert.equal(award, fixture.members[0], 'The first stored team did not get the best player.')
    return { parsed, blocked: blocked.error.trim() }
  } finally {
    await cleanup(fixture, year)
  }
}

const yearA = await pickYear()
const yearB = await pickYear([yearA])
const removalFirst = await runRemovalFirst(yearA)
const floorFirst = await runFloorFirst(yearB)
console.log(JSON.stringify({ ok: true, removalFirst, floorFirst }))

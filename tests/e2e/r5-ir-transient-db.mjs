import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`

function query(sql, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGOPTIONS: options.pgoptions ?? '' },
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

const pickYear = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const year = 9600 + Math.floor(Math.random() * 300)
    if (await one(`SELECT count(*) FROM public.season_weeks WHERE season_year = ${year}`) === '0') return year
  }
  throw new Error('Could not find an unused season year')
}

const year = await pickYear()
const league = randomUUID()
const season = randomUUID()
const users = [randomUUID(), randomUUID()]
const members = [randomUUID(), randomUUID()]
const freeAgent = randomUUID()
const irPlayers = [randomUUID(), randomUUID()]
const weekEnd = await one(`SELECT (now() AT TIME ZONE 'America/New_York')::date`)

const setup = async () => {
  const statements = [
    `INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ${users.map((user) => `(${quote(user)}, 'authenticated', 'authenticated', ${quote(`${user}@example.test`)}, 'x', now(), '{}', '{}', now(), now())`).join(',')}`,
    `INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, ir_slots, timezone)
     VALUES (${quote(league)}, 'IR transient', ${quote(league)}, ${quote(users[0])}, 'active', 20, 1, 'Pacific/Kiritimati')`,
    `INSERT INTO public.league_seasons(id, league_id, season_year, is_current) VALUES (${quote(season)}, ${quote(league)}, ${year}, true)`,
    `INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
     VALUES ${members.map((member, index) => `(${quote(member)}, ${quote(league)}, ${quote(users[index])}, ${quote(index === 0 ? 'commissioner' : 'manager')}, ${quote(`IR team ${index + 1}`)})`).join(',')}`,
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
    `INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
     VALUES (${quote(league)}, ${quote(season)}, ${quote(members[0])}, true, now())
     ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled = true, enabled_at = now()`,
    `INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
     VALUES (${quote(freeAgent)}, ${quote(freeAgent)}, 'Free', 'Agent', 'PG', ARRAY['PG'], NULL, 'ZZ')`,
    `INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
     VALUES (${quote(league)}, ${quote(season)}, ${year}, ${quote(freeAgent)}, '{}'::jsonb, 40, 1)`,
  ]
  for (const [index, member] of members.entries()) {
    for (let slot = 0; slot < 15; slot += 1) {
      const player = randomUUID()
      statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
        VALUES (${quote(player)}, ${quote(player)}, 'Active${index}${slot}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
      statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
        VALUES (${quote(league)}, ${quote(season)}, ${quote(member)}, ${quote(player)}, 'draft')`)
    }
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(irPlayers[index])}, ${quote(irPlayers[index])}, 'Healthy${index}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
    statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir)
      VALUES (${quote(league)}, ${quote(season)}, ${quote(member)}, ${quote(irPlayers[index])}, 'draft', true)`)
  }
  await one(`BEGIN; ${statements.join('; ')}; COMMIT;`)
}

const cleanup = async () => {
  await one(`DELETE FROM public.leagues WHERE id = ${quote(league)};
    DELETE FROM public.players WHERE id = ANY(ARRAY[${[freeAgent, ...irPlayers].map(quote).join(',')}]::uuid[]);
    DELETE FROM auth.users WHERE id = ANY(ARRAY[${users.map(quote).join(',')}]::uuid[]);`)
}

const irCall = (member) => query(
  `SET lock_timeout='300ms'; SELECT public.auto_manage_ir_service(${quote(league)}, ${quote(season)}, ${quote(member)})`,
  { pgoptions: '-c statement_timeout=20000' },
)

const floorCall = () => query(
  `SET lock_timeout='300ms'; SELECT private.run_league_roster_floor(${quote(league)}, ${quote(season)})`,
  { pgoptions: '-c statement_timeout=20000' },
)

const awards = () => one(`SELECT count(*) FROM private.roster_floor_awards WHERE league_id = ${quote(league)}`)
const onIr = (player) => one(`SELECT is_on_ir FROM public.roster_players WHERE league_id = ${quote(league)} AND player_id = ${quote(player)}`)

await setup()
try {
  const holder = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
    `BEGIN; SELECT 1 FROM public.players WHERE id = ANY(ARRAY[${irPlayers.map(quote).join(',')}]::uuid[]) FOR UPDATE; SELECT pg_sleep(5); COMMIT;`],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  let holderError = ''
  holder.stderr.on('data', (chunk) => { holderError += chunk })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const active = await one(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(5)%' AND state = 'active'`)
    if (active !== '0') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const autoLineup = await irCall(members[0])
  assert.notEqual(autoLineup.code, 0, 'A transient IR move failure returned success for the Auto Lineup team.')
  assert.match(autoLineup.error, /55P03/, `The Auto Lineup IR failure did not surface 55P03: ${autoLineup.error}`)
  assert.equal(await onIr(irPlayers[0]), 't', 'The failed Auto Lineup IR pass committed a partial move.')

  const manual = await irCall(members[1])
  assert.notEqual(manual.code, 0, 'A transient IR move failure returned success for the manual team.')
  assert.match(manual.error, /55P03/, `The manual IR failure did not surface 55P03: ${manual.error}`)

  const deferred = await floorCall()
  assert.equal(deferred.code, 0, deferred.error)
  const deferredResult = JSON.parse(deferred.output)
  assert.equal(deferredResult.status, 'deferred', `The floor did not defer: ${deferred.output}`)
  assert.equal(deferredResult.reason, 'ir_transient', `The floor deferred for the wrong reason: ${deferred.output}`)
  assert.equal(await awards(), '0', 'The floor awarded a free agent ahead of a healthy legal IR return.')
  assert.equal(await one(`SELECT count(*) FROM private.roster_floor_weeks WHERE league_id = ${quote(league)} AND status = 'completed'`), '0',
    'The deferred floor completed the week.')

  await new Promise((resolve) => holder.on('close', resolve))
  assert.equal(holderError.trim(), '', holderError)

  for (const [index, member] of members.entries()) {
    const retried = await irCall(member)
    assert.equal(retried.code, 0, retried.error)
    assert.equal(await onIr(irPlayers[index]), 'f', `The retried IR move did not activate the healthy player for member ${index}.`)
  }

  const completed = await floorCall()
  assert.equal(completed.code, 0, completed.error)
  const completedResult = JSON.parse(completed.output)
  assert.equal(completedResult.status, 'completed', `The retried floor did not complete: ${completed.output}`)
  assert.equal(completedResult.awarded, 0, `The retried floor awarded a free agent: ${completed.output}`)
  assert.equal(await awards(), '0', 'The retried floor awarded a free agent.')
  assert.equal(await one(`SELECT count(*) FROM public.roster_players WHERE league_id = ${quote(league)} AND member_id = ${quote(members[0])} AND NOT is_on_ir AND NOT is_on_taxi`), '16',
    'The Auto Lineup team did not reach the floor through its IR return.')
  assert.equal(await one(`SELECT count(*) FROM public.roster_players WHERE league_id = ${quote(league)} AND member_id = ${quote(members[1])} AND NOT is_on_ir AND NOT is_on_taxi`), '16',
    'The manual team did not reach the floor through its IR return.')
  console.log('PASS r5-ir-transient')
} finally {
  await cleanup()
}

const floorYear = await pickYear()
const floorLeague = randomUUID()
const floorSeason = randomUUID()
const floorUsers = [randomUUID(), randomUUID()]
const floorMembers = [randomUUID(), randomUUID()]
const floorFreeAgent = randomUUID()
const floorIrPlayer = randomUUID()
const floorWeekEnd = await one(`SELECT (now() AT TIME ZONE 'America/New_York')::date`)

const setupFloorOnly = async () => {
  const statements = [
    `INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ${floorUsers.map((user) => `(${quote(user)}, 'authenticated', 'authenticated', ${quote(`${user}@example.test`)}, 'x', now(), '{}', '{}', now(), now())`).join(',')}`,
    `INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, ir_slots, timezone)
     VALUES (${quote(floorLeague)}, 'Floor only', ${quote(floorLeague)}, ${quote(floorUsers[0])}, 'active', 20, 1, 'Pacific/Kiritimati')`,
    `INSERT INTO public.league_seasons(id, league_id, season_year, is_current) VALUES (${quote(floorSeason)}, ${quote(floorLeague)}, ${floorYear}, true)`,
    `INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
     VALUES ${floorMembers.map((member, index) => `(${quote(member)}, ${quote(floorLeague)}, ${quote(floorUsers[index])}, ${quote(index === 0 ? 'commissioner' : 'manager')}, ${quote(`Floor team ${index + 1}`)})`).join(',')}`,
    `INSERT INTO public.waiver_priorities(league_id, league_season_id, member_id, priority)
     VALUES ${floorMembers.map((member, index) => `(${quote(floorLeague)}, ${quote(floorSeason)}, ${quote(member)}, ${index + 1})`).join(',')}`,
    `INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
     VALUES (${quote(floorLeague)}, 16, false, now(), now())`,
    `INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
     SELECT ${quote(floorLeague)}, ${quote(floorSeason)}, true, league.scoring_settings
       FROM public.leagues league WHERE league.id = ${quote(floorLeague)}
     ON CONFLICT (league_season_id) DO UPDATE
       SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring`,
    `INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES (${quote(floorLeague)}, ${quote(floorSeason)}, ${quote(floorWeekEnd)}::date)`,
    `INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
     VALUES (${floorYear}, 1, ${quote(floorWeekEnd)}::date - 6, ${quote(floorWeekEnd)}::date)`,
    `INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
     VALUES (${quote(floorLeague)}, ${quote(floorSeason)}, 1, ${quote(floorMembers[0])}, ${quote(floorMembers[1])})`,
    `INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
     VALUES (${quote(floorLeague)}, ${quote(floorSeason)}, ${quote(floorMembers[0])}, true, now())
     ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled = true, enabled_at = now()`,
    `INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
     VALUES (${quote(floorFreeAgent)}, ${quote(floorFreeAgent)}, 'Floor', 'Agent', 'PG', ARRAY['PG'], NULL, 'ZZ')`,
    `INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
     VALUES (${quote(floorLeague)}, ${quote(floorSeason)}, ${floorYear}, ${quote(floorFreeAgent)}, '{}'::jsonb, 40, 1)`,
  ]
  for (let slot = 0; slot < 15; slot += 1) {
    const player = randomUUID()
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Floor${slot}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
    statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES (${quote(floorLeague)}, ${quote(floorSeason)}, ${quote(floorMembers[0])}, ${quote(player)}, 'draft')`)
  }
  for (let slot = 0; slot < 16; slot += 1) {
    const player = randomUUID()
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Full${slot}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
    statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES (${quote(floorLeague)}, ${quote(floorSeason)}, ${quote(floorMembers[1])}, ${quote(player)}, 'draft')`)
  }
  statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES (${quote(floorIrPlayer)}, ${quote(floorIrPlayer)}, 'FloorHealthy', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
  statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir)
    VALUES (${quote(floorLeague)}, ${quote(floorSeason)}, ${quote(floorMembers[0])}, ${quote(floorIrPlayer)}, 'draft', true)`)
  await one(`BEGIN; ${statements.join('; ')}; COMMIT;`)
}

const cleanupFloorOnly = async () => {
  await one(`DELETE FROM public.leagues WHERE id = ${quote(floorLeague)};
    DELETE FROM public.players WHERE id = ANY(ARRAY[${[floorFreeAgent, floorIrPlayer].map(quote).join(',')}]::uuid[]);
    DELETE FROM auth.users WHERE id = ANY(ARRAY[${floorUsers.map(quote).join(',')}]::uuid[]);`)
}

const floorCallFor = (leagueId, seasonId) => query(
  `SET lock_timeout='300ms'; SELECT private.run_league_roster_floor(${quote(leagueId)}, ${quote(seasonId)})`,
  { pgoptions: '-c statement_timeout=20000' },
)
const awardsFor = (leagueId) => one(`SELECT count(*) FROM private.roster_floor_awards WHERE league_id = ${quote(leagueId)}`)
const onIrFor = (leagueId, player) => one(`SELECT is_on_ir FROM public.roster_players WHERE league_id = ${quote(leagueId)} AND player_id = ${quote(player)}`)

await setupFloorOnly()
try {
  const holder = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
    `BEGIN; SELECT 1 FROM public.players WHERE id = ${quote(floorIrPlayer)} FOR UPDATE; SELECT pg_sleep(5); COMMIT;`],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  let holderError = ''
  holder.stderr.on('data', (chunk) => { holderError += chunk })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const active = await one(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(5)%' AND state = 'active'`)
    if (active !== '0') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const deferred = await floorCallFor(floorLeague, floorSeason)
  assert.equal(deferred.code, 0, deferred.error)
  const deferredResult = JSON.parse(deferred.output)
  assert.equal(deferredResult.status, 'deferred', `The floor-only league did not defer: ${deferred.output}`)
  assert.equal(deferredResult.reason, 'ir_transient', `The floor-only league deferred for the wrong reason: ${deferred.output}`)
  assert.equal(await awardsFor(floorLeague), '0', 'The floor-only league awarded a free agent ahead of a healthy legal IR return.')
  assert.equal(await onIrFor(floorLeague, floorIrPlayer), 't', 'The floor-only league changed the IR player on a deferred pass.')
  assert.equal(await one(`SELECT count(*) FROM private.roster_floor_weeks WHERE league_id = ${quote(floorLeague)} AND status = 'completed'`), '0',
    'The floor-only league completed the week on a deferred pass.')

  await new Promise((resolve) => holder.on('close', resolve))
  assert.equal(holderError.trim(), '', holderError)

  const completed = await floorCallFor(floorLeague, floorSeason)
  assert.equal(completed.code, 0, completed.error)
  const completedResult = JSON.parse(completed.output)
  assert.equal(completedResult.status, 'completed', `The retried floor-only league did not complete: ${completed.output}`)
  assert.equal(completedResult.awarded, 0, `The retried floor-only league awarded a free agent: ${completed.output}`)
  assert.equal(await awardsFor(floorLeague), '0', 'The retried floor-only league awarded a free agent.')
  assert.equal(await onIrFor(floorLeague, floorIrPlayer), 'f', 'The retried floor-only league did not activate the healthy IR player.')
  assert.equal(await one(`SELECT count(*) FROM public.roster_players WHERE league_id = ${quote(floorLeague)} AND member_id = ${quote(floorMembers[0])} AND NOT is_on_ir AND NOT is_on_taxi`), '16',
    'The floor-only league did not reach the floor through its IR return.')
  console.log('PASS r5-ir-transient floor-only')
} finally {
  await cleanupFloorOnly()
}

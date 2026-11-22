import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`

function query(sql, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`psql timed out: ${sql.slice(0, 120)}`))
    }, timeout)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.on('error', (cause) => { clearTimeout(timer); reject(cause) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: output.trim(), error }) })
  })
}

const one = async (sql, timeout) => {
  const result = await query(sql, timeout)
  assert.equal(result.code, 0, result.error)
  return result.output
}

const pickYear = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const year = 9000 + Math.floor(Math.random() * 1000)
    if (await one(`SELECT count(*) FROM public.season_weeks WHERE season_year = ${year}`) === '0') return year
  }
  throw new Error('Could not find an unused season year')
}

const setup = async ({ year, short = 15, full = 16, freeAgents = 1, rosterSize = 20, floor = 16, capacityTrade = false, injured = false, autoIr = false }) => {
  const league = randomUUID()
  const season = randomUUID()
  const users = [randomUUID(), randomUUID()]
  const members = [randomUUID(), randomUUID()]
  const players = []
  const freeAgentIds = []
  const today = await one(`SELECT (now() AT TIME ZONE 'America/New_York')::date`)
  const statements = [
    `INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ${users.map((user) => `(${quote(user)}, 'authenticated', 'authenticated', ${quote(`${user}@example.test`)}, 'x', now(), '{}', '{}', now(), now())`).join(',')}`,
    `INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, timezone)
     VALUES (${quote(league)}, 'Floor lease', ${quote(league)}, ${quote(users[0])}, 'active', ${rosterSize}, 'Pacific/Kiritimati')`,
    `INSERT INTO public.league_seasons(id, league_id, season_year, is_current) VALUES (${quote(season)}, ${quote(league)}, ${year}, true)`,
    `INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
     VALUES ${members.map((member, index) => `(${quote(member)}, ${quote(league)}, ${quote(users[index])}, ${quote(index === 0 ? 'commissioner' : 'manager')}, ${quote(`Floor team ${index + 1}`)})`).join(',')}`,
    `INSERT INTO public.waiver_priorities(league_id, league_season_id, member_id, priority)
     VALUES ${members.map((member, index) => `(${quote(league)}, ${quote(season)}, ${quote(member)}, ${index + 1})`).join(',')}`,
    `INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
     VALUES (${quote(league)}, ${floor}, ${autoIr}, now(), now())`,
    `INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
     SELECT ${quote(league)}, ${quote(season)}, true, league.scoring_settings
       FROM public.leagues league WHERE league.id = ${quote(league)}
   ON CONFLICT (league_season_id) DO UPDATE
     SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring`,
    `INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
     VALUES (${quote(league)}, ${quote(season)}, ${quote(today)}::date)`,
    `INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
     VALUES (${year}, 1, ${quote(today)}::date - 6, ${quote(today)}::date)`,
    `INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
     VALUES (${quote(league)}, ${quote(season)}, 1, ${quote(members[0])}, ${quote(members[1])})`,
    `INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, team_order, status)
     VALUES (${quote(league)}, ${quote(season)}, 1, ${quote(today)}::date,
       ARRAY[${quote(members[0])}::uuid, ${quote(members[1])}::uuid], 'pending')`,
    `UPDATE public.nba_games SET status='Final', game_time=now() - interval '1 hour'
      WHERE game_date IN (${quote(today)}::date - 1, ${quote(today)}::date)`,
  ]
  const addPlayer = (member, index) => {
    const player = randomUUID()
    players.push(player)
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Roster${index}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
    statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES (${quote(league)}, ${quote(season)}, ${quote(member)}, ${quote(player)}, 'draft')`)
    return player
  }
  for (let index = 0; index < short; index += 1) addPlayer(members[0], index)
  for (let index = 0; index < full; index += 1) addPlayer(members[1], index)
  for (let index = 0; index < freeAgents; index += 1) {
    const player = randomUUID()
    players.push(player)
    freeAgentIds.push(player)
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Free${index}', 'Test', 'PG', ARRAY['PG'], NULL, 'FA')`)
    statements.push(`INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
      VALUES (${quote(league)}, ${quote(season)}, ${year}, ${quote(player)}, '{}'::jsonb, ${40 - index}, 1)`)
  }
  if (injured) {
    const player = randomUUID()
    players.push(player)
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Injured', 'Test', 'PG', ARRAY['PG'], 'Out', (${quote(today)}::date + 14)::text, 'ZZ')`)
    statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES (${quote(league)}, ${quote(season)}, ${quote(members[0])}, ${quote(player)}, 'draft')`)
    statements.push(`UPDATE public.leagues SET ir_slots = 1 WHERE id = ${quote(league)}`)
  }
  if (capacityTrade) {
    const trade = randomUUID()
    const incoming = [addPlayer(members[1], full), addPlayer(members[1], full + 1)]
    statements.push(`INSERT INTO public.trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, accepted_at)
      VALUES (${quote(trade)}, ${quote(league)}, ${quote(season)}, ${quote(members[1])}, ${quote(members[0])}, 'accepted', now())`)
    statements.push(`INSERT INTO public.trade_participants(trade_id, member_id, sort_order, is_initiator, accepted_at)
      VALUES (${quote(trade)}, ${quote(members[0])}, 0, false, now()), (${quote(trade)}, ${quote(members[1])}, 1, true, now())`)
    statements.push(`INSERT INTO public.trade_items(trade_id, side, player_id, from_member_id, to_member_id)
      VALUES ${incoming.map((player) => `(${quote(trade)}, 'proposer', ${quote(player)}, ${quote(members[1])}, ${quote(members[0])})`).join(',')}`)
  }
  await one(`BEGIN; ${statements.join('; ')}; COMMIT;`)
  return { league, season, year, members, players, freeAgentIds, users, today }
}

const workItem = async (fixture, { key, status = 'running', lease = '10 minutes', label }) => {
  await one(`INSERT INTO private.work_items(kind, key, status, lease_token, lease_until, invocation_key, payload, league_id)
    VALUES ('roster-floor', ${quote(label)}, ${quote(status)},
      ${status === 'running' ? 'gen_random_uuid()' : 'NULL'},
      ${status === 'running' ? `now() + interval '${lease}'` : 'NULL'},
      ${quote(key)}, jsonb_build_object('test', ${quote(label)}), ${quote(fixture.league)})`)
}

const callFloor = (fixture, key, timeout = 60_000) => query(
  `SELECT set_config('request.headers', jsonb_build_object('x-pancake-work-key', ${quote(key)})::text, false);
   SELECT private.run_league_roster_floor(${quote(fixture.league)}, ${quote(fixture.season)});`,
  timeout,
)

const callService = (key, timeout = 60_000) => query(
  `SELECT set_config('request.headers', jsonb_build_object('x-pancake-work-key', ${quote(key)})::text, false);
   SELECT public.process_roster_floor_service();`,
  timeout,
)

const weekStatus = (fixture) => one(`SELECT status FROM private.roster_floor_weeks
  WHERE league_id = ${quote(fixture.league)} AND league_season_id = ${quote(fixture.season)} AND week_number = 1`)

const awardCount = (fixture) => one(`SELECT count(*) FROM private.roster_floor_awards
  WHERE league_id = ${quote(fixture.league)} AND league_season_id = ${quote(fixture.season)}`)

const activeCount = (fixture, member) => one(`SELECT count(*) FROM public.roster_players
  WHERE league_id = ${quote(fixture.league)} AND league_season_id = ${quote(fixture.season)}
    AND member_id = ${quote(member)} AND NOT is_on_ir AND NOT is_on_taxi`)

const cleanup = async (fixture) => {
  await one(`DELETE FROM public.leagues WHERE id = ${quote(fixture.league)}`)
  await one(`DELETE FROM public.players WHERE id = ANY(ARRAY[${fixture.players.map(quote).join(',')}]::uuid[])`)
  await one(`DELETE FROM auth.users WHERE id = ANY(ARRAY[${fixture.users.map(quote).join(',')}]::uuid[])`)
  await one(`DELETE FROM public.season_weeks WHERE season_year = ${fixture.year}`)
}

const run = async (label, body) => {
  let fixture
  try {
    fixture = await body()
  } finally {
    if (fixture) await cleanup(fixture)
  }
  console.log(`PASS r6-floor-lease ${label}`)
}

await run('A stale key at start', async () => {
  const fixture = await setup({ year: await pickYear(), short: 15, full: 16, freeAgents: 1 })
  const stale = randomUUID()
  await workItem(fixture, { key: stale, status: 'succeeded', label: `stale-${stale}` })
  const result = await callFloor(fixture, stale)
  assert.notEqual(result.code, 0, 'a stale work key completed the floor')
  assert.match(result.error, /Work lease is no longer current/)
  assert.equal(await weekStatus(fixture), 'pending', 'a stale work key marked the week completed')
  assert.equal(await awardCount(fixture), '0', 'a stale work key committed an award')
  assert.equal(await activeCount(fixture, fixture.members[0]), '15', 'a stale work key changed the roster')
  return fixture
})

await run('B lease expiry while blocked on a lock', async () => {
  const fixture = await setup({ year: await pickYear(), short: 15, full: 16, freeAgents: 1 })
  const key = randomUUID()
  await workItem(fixture, { key, status: 'running', lease: '3 seconds', label: `expiring-${key}` })
  const holder = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT pg_advisory_lock(hashtext(${quote(fixture.league)}), hashtext(${quote(fixture.members[0])}));
     SELECT pg_sleep(8);
     SELECT pg_advisory_unlock_all();`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const holderDone = new Promise((resolve) => holder.on('close', resolve))
  let held = false
  for (let attempt = 0; attempt < 100 && !held; attempt += 1) {
    held = await one(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`) !== '0'
    if (!held) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(held, 'the lock holder never acquired the advisory lock')
  const result = await callFloor(fixture, key)
  await holderDone
  assert.notEqual(result.code, 0, 'an expiring lease completed the floor')
  assert.match(result.error, /Work lease is no longer current/)
  assert.equal(await weekStatus(fixture), 'pending', 'an expiring lease marked the week completed')
  assert.equal(await awardCount(fixture), '0', 'an expiring lease committed an award')
  return fixture
})

await run('C no-candidate completion refuses a stale key', async () => {
  const fixture = await setup({ year: await pickYear(), short: 16, full: 16, freeAgents: 0 })
  const stale = randomUUID()
  await workItem(fixture, { key: stale, status: 'succeeded', label: `stale-empty-${stale}` })
  const result = await callFloor(fixture, stale)
  assert.notEqual(result.code, 0, 'a stale work key completed an empty week')
  assert.match(result.error, /Work lease is no longer current/)
  assert.equal(await weekStatus(fixture), 'pending', 'a stale work key completed the empty week')
  return fixture
})

await run('D a current worker completes once after a stale attempt', async () => {
  const fixture = await setup({ year: await pickYear(), short: 15, full: 16, freeAgents: 1 })
  const stale = randomUUID()
  await workItem(fixture, { key: stale, status: 'succeeded', label: `stale-recover-${stale}` })
  assert.notEqual((await callFloor(fixture, stale)).code, 0, 'a stale work key completed the floor')
  const current = randomUUID()
  await workItem(fixture, { key: current, status: 'running', lease: '10 minutes', label: `current-${current}` })
  const result = await callFloor(fixture, current)
  assert.equal(result.code, 0, result.error)
  assert.match(result.output, /"status": "completed"/)
  assert.match(result.output, /"awarded": 1/)
  assert.equal(await weekStatus(fixture), 'completed')
  assert.equal(await awardCount(fixture), '1')
  assert.equal(await activeCount(fixture, fixture.members[0]), '16')
  const repeat = await callFloor(fixture, current)
  assert.equal(repeat.code, 0, repeat.error)
  assert.match(repeat.output, /"awarded": 0/)
  assert.equal(await awardCount(fixture), '1', 'a repeat run double-awarded')
  return fixture
})

await run('E a concurrent retry cannot double-award', async () => {
  const fixture = await setup({ year: await pickYear(), short: 15, full: 16, freeAgents: 1 })
  const keys = [randomUUID(), randomUUID()]
  for (const key of keys) await workItem(fixture, { key, status: 'running', lease: '10 minutes', label: `concurrent-${key}` })
  const results = await Promise.all(keys.map((key) => callFloor(fixture, key)))
  for (const result of results) assert.equal(result.code, 0, result.error)
  assert.equal(await awardCount(fixture), '1', 'concurrent runs double-awarded')
  assert.equal(await weekStatus(fixture), 'completed')
  const repeat = await callFloor(fixture, keys[0])
  assert.equal(repeat.code, 0, repeat.error)
  assert.match(repeat.output, /"awarded": 0/)
  assert.equal(await awardCount(fixture), '1')
  return fixture
})

await run('F a capacity rejection skips the candidate and completes', async () => {
  const fixture = await setup({ year: await pickYear(), short: 15, full: 16, freeAgents: 1, rosterSize: 17, floor: 16, capacityTrade: true })
  await one(`UPDATE public.leagues SET roster_size = 16 WHERE id = ${quote(fixture.league)}`)
  const key = randomUUID()
  await workItem(fixture, { key, status: 'running', lease: '10 minutes', label: `capacity-${key}` })
  const result = await callFloor(fixture, key)
  assert.equal(result.code, 0, result.error)
  assert.match(result.output, /"status": "completed"/)
  assert.match(result.output, /"awarded": 0/)
  assert.equal(await weekStatus(fixture), 'completed')
  assert.equal(await awardCount(fixture), '0', 'a capacity rejection committed an award')
  assert.equal(await activeCount(fixture, fixture.members[0]), '15', 'a capacity rejection changed the roster')
  assert.equal(await one(`SELECT count(*) FROM public.roster_players
    WHERE league_id = ${quote(fixture.league)} AND player_id = ${quote(fixture.freeAgentIds[0])}`), '0', 'the rejected candidate was added')
  return fixture
})

await run('G the service entry point refuses a stale key and completes once', async () => {
  const fixture = await setup({ year: await pickYear(), short: 14, full: 16, freeAgents: 1, injured: true, autoIr: true })
  const stale = randomUUID()
  await workItem(fixture, { key: stale, status: 'succeeded', label: `service-stale-${stale}` })
  const staleResult = await callService(stale)
  assert.equal(staleResult.code, 0, staleResult.error)
  assert.match(staleResult.output, /Work lease is no longer current/)
  assert.equal(await weekStatus(fixture), 'pending', 'the service completed the week with a stale key')
  assert.equal(await awardCount(fixture), '0', 'the service committed an award with a stale key')
  assert.equal(await activeCount(fixture, fixture.members[0]), '15', 'the service changed the roster with a stale key')
  assert.equal(await one(`SELECT count(*) FROM public.roster_players
    WHERE league_id = ${quote(fixture.league)} AND member_id = ${quote(fixture.members[0])} AND is_on_ir`), '0',
    'the service moved a player to IR with a stale key')
  const current = randomUUID()
  await workItem(fixture, { key: current, status: 'running', lease: '10 minutes', label: `service-current-${current}` })
  const currentResult = await callService(current)
  assert.equal(currentResult.code, 0, currentResult.error)
  assert.match(currentResult.output, /"status": "completed"/)
  assert.equal(await weekStatus(fixture), 'completed')
  assert.equal(await awardCount(fixture), '1')
  assert.equal(await one(`SELECT count(*) FROM public.roster_players
    WHERE league_id = ${quote(fixture.league)} AND member_id = ${quote(fixture.members[0])} AND is_on_ir`), '1',
    'the current worker did not move the injured player to IR')
  const repeat = await callService(current)
  assert.equal(repeat.code, 0, repeat.error)
  assert.equal(await awardCount(fixture), '1', 'a repeat service run double-awarded')
  return fixture
})

console.log(JSON.stringify({ ok: true }))

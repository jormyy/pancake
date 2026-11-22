import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`

function query(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] })
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

const race = (statements) => Promise.all(statements.map((statement) =>
  query(`BEGIN; SET LOCAL statement_timeout='20s'; ${statement}; SELECT pg_sleep(0.25); COMMIT;`)))

const pickYear = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const year = 9000 + Math.floor(Math.random() * 1000)
    if (await one(`SELECT count(*) FROM public.season_weeks WHERE season_year = ${year}`) === '0') return year
  }
  throw new Error('Could not find an unused season year')
}

const setup = async (year) => {
  const league = randomUUID()
  const season = randomUUID()
  const users = [randomUUID(), randomUUID()]
  const members = [randomUUID(), randomUUID()]
  const freeAgents = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const players = [...freeAgents]
  const weekEnd = await one(`SELECT (now() AT TIME ZONE 'America/New_York')::date`)
  const statements = [
    `INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ${users.map((user) => `(${quote(user)}, 'authenticated', 'authenticated', ${quote(`${user}@example.test`)}, 'x', now(), '{}', '{}', now(), now())`).join(',')}`,
    `INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, timezone)
     VALUES (${quote(league)}, 'Floor concurrency', ${quote(league)}, ${quote(users[0])}, 'active', 20, 'Pacific/Kiritimati')`,
    `INSERT INTO public.league_seasons(id, league_id, season_year, is_current) VALUES (${quote(season)}, ${quote(league)}, ${year}, true)`,
    `INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
     VALUES ${members.map((member, index) => `(${quote(member)}, ${quote(league)}, ${quote(users[index])}, ${quote(index === 0 ? 'commissioner' : 'manager')}, ${quote(`Floor team ${index + 1}`)})`).join(',')}`,
    `INSERT INTO public.waiver_priorities(league_id, league_season_id, member_id, priority)
     VALUES ${members.map((member, index) => `(${quote(league)}, ${quote(season)}, ${quote(member)}, ${index + 1})`).join(',')}`,
    `INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at) VALUES (${quote(league)}, 16, true, now(), now())`,
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
  ]
  for (const member of members) {
    for (let index = 0; index < 15; index += 1) {
      const player = randomUUID()
      players.push(player)
      statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
        VALUES (${quote(player)}, ${quote(player)}, 'Roster${index}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
      statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
        VALUES (${quote(league)}, ${quote(season)}, ${quote(member)}, ${quote(player)}, 'draft')`)
    }
  }
  for (const [index, player] of freeAgents.entries()) {
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Free${index}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
    statements.push(`INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
      VALUES (${quote(league)}, ${quote(season)}, ${year}, ${quote(player)}, '{}'::jsonb, ${40 - index}, 1)`)
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

const year = await pickYear()
let fixture
try {
  fixture = await setup(year)
  const call = `SELECT public.process_roster_floor_service(${quote(fixture.league)}, ${quote(fixture.season)})`
  const results = await race([call, call])
  for (const result of results) assert.equal(result.code, 0, result.error)

  const awards = await one(`SELECT count(*) || ':' || count(DISTINCT player_id) FROM private.roster_floor_awards WHERE league_id = ${quote(fixture.league)}`)
  assert.equal(awards, '2:2', 'two concurrent sessions award each player once')
  const active = await one(`SELECT string_agg(count::text, ',' ORDER BY member_id) FROM (
    SELECT member_id, count(*) AS count FROM public.roster_players
     WHERE league_id = ${quote(fixture.league)} AND NOT is_on_ir AND NOT is_on_taxi GROUP BY member_id) counts`)
  assert.equal(active, '16,16', 'both short teams reach the floor')

  const repeat = await one(call)
  assert.match(repeat, /"awarded": 0/, 'a repeat run awards nothing')
  const afterRepeat = await one(`SELECT count(*) FROM private.roster_floor_awards WHERE league_id = ${quote(fixture.league)}`)
  assert.equal(afterRepeat, '2', 'a repeat run adds no awards')

  const order = await one(`SELECT array_length(team_order, 1) FROM private.roster_floor_weeks WHERE league_id = ${quote(fixture.league)}`)
  assert.equal(order, '2', 'the week stores the shuffled team order')

  console.log(JSON.stringify({ ok: true, awards, active, repeat: JSON.parse(repeat) }))
} finally {
  if (fixture) {
    await one(`DELETE FROM public.leagues WHERE id = ${quote(fixture.league)}`)
    await one(`DELETE FROM public.players WHERE id = ANY(ARRAY[${fixture.players.map(quote).join(',')}]::uuid[])`)
    await one(`DELETE FROM auth.users WHERE id = ANY(ARRAY[${fixture.users.map(quote).join(',')}]::uuid[])`)
  }
  await one(`DELETE FROM public.season_weeks WHERE season_year = ${year} AND week_number = 1`)
}

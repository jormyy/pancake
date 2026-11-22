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

const pickYear = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const year = 9100 + Math.floor(Math.random() * 150)
    if (await one(`SELECT count(*) FROM public.season_weeks WHERE season_year = ${year}`) === '0') return year
  }
  throw new Error('Could not find an unused season year')
}

const year = await pickYear()
const league = randomUUID()
const season = randomUUID()
const users = [randomUUID(), randomUUID()]
const members = [randomUUID(), randomUUID()]
const players = Object.fromEntries(['played', 'dnp', 'zeroMinute', 'cancelled', 'tieA', 'tieB'].map((key) => [key, randomUUID()]))
const games = Object.fromEntries(['g1', 'g2', 'cancelled'].map((key) => [key, randomUUID()]))
const weekEnd = await one(`SELECT (now() AT TIME ZONE 'America/New_York')::date`)

const setup = async () => {
  const statements = [
    `INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ${users.map((user) => `(${quote(user)}, 'authenticated', 'authenticated', ${quote(`${user}@example.test`)}, 'x', now(), '{}', '{}', now(), now())`).join(',')}`,
    `INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, ir_slots, timezone, scoring_settings)
     VALUES (${quote(league)}, 'View semantics', ${quote(league)}, ${quote(users[0])}, 'active', 20, 1, 'Pacific/Kiritimati',
       '{"points":1,"rebounds":1,"assists":1,"steals":1,"blocks":1,"turnovers":-1,"three_pointers_made":1,"field_goals_made":0,"field_goals_attempted":0,"free_throws_made":0,"free_throws_attempted":0,"double_double":0,"triple_double":0}'::jsonb)`,
    `INSERT INTO public.league_seasons(id, league_id, season_year, is_current) VALUES (${quote(season)}, ${quote(league)}, ${year}, true)`,
    `INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
     VALUES ${members.map((member, index) => `(${quote(member)}, ${quote(league)}, ${quote(users[index])}, ${quote(index === 0 ? 'commissioner' : 'manager')}, ${quote(`Semantics team ${index + 1}`)})`).join(',')}`,
    `INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
     VALUES (${quote(league)}, 16, true, now(), now())`,
    `INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
     SELECT ${quote(league)}, ${quote(season)}, true, league.scoring_settings FROM public.leagues league WHERE league.id = ${quote(league)}
     ON CONFLICT (league_season_id) DO UPDATE SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring`,
    `INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES (${quote(league)}, ${quote(season)}, ${quote(weekEnd)}::date)`,
    `INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
     VALUES (${year}, 1, ${quote(weekEnd)}::date - 6, ${quote(weekEnd)}::date)`,
    `INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
     VALUES (${quote(league)}, ${quote(season)}, 1, ${quote(members[0])}, ${quote(members[1])})`,
    `INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
     VALUES (${quote(games.g1)}, ${quote(`002${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`)}, ${year}, 1, ${quote(weekEnd)}::date - 3, 'ZZ', 'ZY', 'Final', now() - interval '3 days'),
            (${quote(games.g2)}, ${quote(`002${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`)}, ${year}, 1, ${quote(weekEnd)}::date - 2, 'ZZ', 'ZY', 'Final', now() - interval '2 days'),
            (${quote(games.cancelled)}, ${quote(`002${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`)}, ${year}, 1, ${quote(weekEnd)}::date - 1, 'ZZ', 'ZY', 'Canceled', now() - interval '1 day')`,
  ]
  for (const [key, player] of Object.entries(players)) {
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, ${quote(key)}, 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
  }
  for (let slot = 0; slot < 15; slot += 1) {
    const player = randomUUID()
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Roster${slot}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
    statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES (${quote(league)}, ${quote(season)}, ${quote(members[0])}, ${quote(player)}, 'draft')`)
  }
  for (let slot = 0; slot < 16; slot += 1) {
    const player = randomUUID()
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Full${slot}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
    statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES (${quote(league)}, ${quote(season)}, ${quote(members[1])}, ${quote(player)}, 'draft')`)
  }
  await one(`BEGIN; ${statements.join('; ')}; COMMIT;`)
}

const stat = (player, game, points, didNotPlay = false) => `INSERT INTO public.player_game_stats(id, player_id, game_id, season_year, week_number, points, did_not_play)
  VALUES (gen_random_uuid(), ${quote(player)}, ${quote(game)}, ${year}, 1, ${points}, ${didNotPlay})`

const seedStats = async () => {
  await one(`BEGIN;
    ${stat(players.played, games.g1, 10)}; ${stat(players.played, games.g2, 10)};
    ${stat(players.dnp, games.g1, 10)}; ${stat(players.dnp, games.g2, 0, true)};
    ${stat(players.zeroMinute, games.g1, 10)}; ${stat(players.zeroMinute, games.g2, 0)};
    ${stat(players.cancelled, games.g1, 10)};
    ${stat(players.tieA, games.g1, 7)}; ${stat(players.tieB, games.g1, 7)};
    COMMIT;`)
}

const refresh = async () => {
  const version = await one(`SELECT version FROM private.screen_refresh_queue WHERE league_season_id = ${quote(season)}`)
  await one(`SELECT private.refresh_player_averages(${quote(league)}, ${quote(season)}, ${version})`)
}

const cached = async () => JSON.parse(await one(`SELECT json_object_agg(player_id::text, avg_fantasy_points)
  FROM public.player_season_averages WHERE league_id = ${quote(league)}`))

const cleanup = async () => {
  await one(`DELETE FROM public.leagues WHERE id = ${quote(league)};
    DELETE FROM public.player_game_stats WHERE player_id = ANY(ARRAY[${Object.values(players).map(quote).join(',')}]::uuid[]);
    DELETE FROM public.players WHERE id = ANY(ARRAY[${Object.values(players).map(quote).join(',')}]::uuid[]);
    DELETE FROM public.nba_games WHERE id = ANY(ARRAY[${Object.values(games).map(quote).join(',')}]::uuid[]);
    DELETE FROM auth.users WHERE id = ANY(ARRAY[${users.map(quote).join(',')}]::uuid[]);`)
}

await setup()
try {
  await seedStats()
  await refresh()
  const averages = await cached()
  assert.equal(Number(averages[players.played]), 10, 'Two played games at 10 points do not average 10.')
  assert.equal(Number(averages[players.dnp]), 10, 'A did-not-play game is not excluded from the average.')
  assert.equal(Number(averages[players.zeroMinute]), 5, 'A zero-point played game is not counted in the average.')
  assert.equal(Number(averages[players.cancelled]), 10, 'A cancelled game without stats changed the average.')
  assert.equal(Number(averages[players.tieA]), 7, 'The tie fixture average is wrong.')
  assert.equal(Number(averages[players.tieB]), 7, 'The tie fixture average is wrong.')

  const pool = await one(`SELECT string_agg(player_id::text || ':' || avg_fantasy_points::text, ',' ORDER BY avg_fantasy_points DESC, player_id)
    FROM private.roster_floor_pool(${quote(league)}, ${quote(season)})`)
  const order = pool.split(',').map((entry) => entry.split(':'))
  const tieIndex = (id) => order.findIndex(([entry]) => entry === id)
  assert.equal(tieIndex(players.tieA) < tieIndex(players.tieB), players.tieA < players.tieB, 'The pool tie-break is not the lower player id.')
  assert(order.findIndex(([id]) => id === players.zeroMinute) > order.findIndex(([id]) => id === players.played),
    'The pool does not rank the zero-point game below the two-game average.')

  await one(`UPDATE private.screen_refresh_queue SET averages_initialized = false WHERE league_season_id = ${quote(season)}`)
  const empty = JSON.parse((await query(`SELECT private.run_league_roster_floor(${quote(league)}, ${quote(season)})`)).output)
  assert.equal(empty.reason, 'averages_pending', 'An uninitialized cache did not defer the floor.')
  assert.equal(await one(`SELECT count(*) FROM private.roster_floor_awards WHERE league_id = ${quote(league)}`), '0',
    'An uninitialized cache awarded a free agent.')
  console.log('PASS r5b-view-semantics')
} finally {
  await cleanup()
}

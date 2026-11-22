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
    const year = 9300 + Math.floor(Math.random() * 200)
    if (await one(`SELECT count(*) FROM public.season_weeks WHERE season_year = ${year}`) === '0') return year
  }
  throw new Error('Could not find an unused season year')
}

const year = await pickYear()
const league = randomUUID()
const season = randomUUID()
const users = [randomUUID(), randomUUID()]
const members = [randomUUID(), randomUUID()]
const freeAgents = [randomUUID(), randomUUID()]
const games = [randomUUID(), randomUUID()]
const weekEnd = await one(`SELECT (now() AT TIME ZONE 'America/New_York')::date`)

const setup = async () => {
  const statements = [
    `INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ${users.map((user) => `(${quote(user)}, 'authenticated', 'authenticated', ${quote(`${user}@example.test`)}, 'x', now(), '{}', '{}', now(), now())`).join(',')}`,
    `INSERT INTO public.leagues(id, name, slug, commissioner_id, status, roster_size, ir_slots, timezone, scoring_settings)
     VALUES (${quote(league)}, 'Averages race', ${quote(league)}, ${quote(users[0])}, 'active', 20, 1, 'Pacific/Kiritimati',
       '{"points":1,"rebounds":1,"assists":1,"steals":1,"blocks":1,"turnovers":-1,"three_pointers_made":1,"field_goals_made":0,"field_goals_attempted":0,"free_throws_made":0,"free_throws_attempted":0,"double_double":0,"triple_double":0}'::jsonb)`,
    `INSERT INTO public.league_seasons(id, league_id, season_year, is_current) VALUES (${quote(season)}, ${quote(league)}, ${year}, true)`,
    `INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
     VALUES ${members.map((member, index) => `(${quote(member)}, ${quote(league)}, ${quote(users[index])}, ${quote(index === 0 ? 'commissioner' : 'manager')}, ${quote(`Race team ${index + 1}`)})`).join(',')}`,
    `INSERT INTO public.waiver_priorities(league_id, league_season_id, member_id, priority)
     VALUES ${members.map((member, index) => `(${quote(league)}, ${quote(season)}, ${quote(member)}, ${index + 1})`).join(',')}`,
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
     VALUES ${games.map((game) => `(${quote(game)}, ${quote(`002${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`)}, ${year}, 1, ${quote(weekEnd)}::date - 3, 'ZZ', 'ZY', 'Final', now() - interval '3 days')`).join(',')}`,
  ]
  for (const [index, member] of members.entries()) {
    const count = index === 0 ? 15 : 16
    for (let slot = 0; slot < count; slot += 1) {
      const player = randomUUID()
      statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
        VALUES (${quote(player)}, ${quote(player)}, 'Roster${index}${slot}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
      statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
        VALUES (${quote(league)}, ${quote(season)}, ${quote(member)}, ${quote(player)}, 'draft')`)
    }
  }
  for (const [index, player] of freeAgents.entries()) {
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${quote(player)}, ${quote(player)}, 'Free${index}', 'Agent', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
  }
  await one(`BEGIN; ${statements.join('; ')}; COMMIT;`)
}

const stat = (player, game, points) => `INSERT INTO public.player_game_stats(id, player_id, game_id, season_year, week_number, points, did_not_play)
  VALUES (gen_random_uuid(), ${quote(player)}, ${quote(game)}, ${year}, 1, ${points}, false)`

const seedStats = async () => {
  await one(`BEGIN; ${stat(freeAgents[0], games[0], 20)}; ${stat(freeAgents[0], games[1], 20)};
    ${stat(freeAgents[1], games[0], 10)}; ${stat(freeAgents[1], games[1], 10)}; COMMIT;`)
}

const refresh = async () => {
  const version = await one(`SELECT version FROM private.screen_refresh_queue WHERE league_season_id = ${quote(season)}`)
  await one(`SELECT private.refresh_player_averages(${quote(league)}, ${quote(season)}, ${version})`)
}

const floor = () => query(`SELECT private.run_league_roster_floor(${quote(league)}, ${quote(season)})`)
const awards = () => one(`SELECT count(*) FROM private.roster_floor_awards WHERE league_id = ${quote(league)}`)
const completed = () => one(`SELECT count(*) FROM private.roster_floor_weeks WHERE league_id = ${quote(league)} AND status = 'completed'`)
const cached = async () => JSON.parse(await one(`SELECT json_object_agg(player_id::text, avg_fantasy_points)
  FROM public.player_season_averages WHERE league_id = ${quote(league)}`))

const cleanup = async () => {
  await one(`DELETE FROM public.leagues WHERE id = ${quote(league)};
    DELETE FROM public.player_game_stats WHERE player_id = ANY(ARRAY[${freeAgents.map(quote).join(',')}]::uuid[]);
    DELETE FROM public.players WHERE id = ANY(ARRAY[${freeAgents.map(quote).join(',')}]::uuid[]);
    DELETE FROM public.nba_games WHERE id = ANY(ARRAY[${games.map(quote).join(',')}]::uuid[]);
    DELETE FROM auth.users WHERE id = ANY(ARRAY[${users.map(quote).join(',')}]::uuid[]);`)
}

const race = async (mutate, lockPlayer = freeAgents[0]) => {
  const holder = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
    `BEGIN; SELECT 1 FROM public.players WHERE id = ${quote(lockPlayer)} FOR UPDATE; SELECT pg_sleep(2); ${mutate}; COMMIT;`],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  let holderError = ''
  holder.stderr.on('data', (chunk) => { holderError += chunk })
  const holderDone = new Promise((resolve) => holder.on('close', resolve))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const active = await one(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(2)%' AND state = 'active'`)
    if (active !== '0') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const started = Date.now()
  const result = await floor()
  const elapsed = Date.now() - started
  await holderDone
  const dirty = await one(`SELECT count(*) FROM private.screen_average_dirty WHERE league_season_id = ${quote(season)}`)
  console.log('race elapsed', elapsed, 'dirty', dirty, 'holder', holderError.trim().split('\n')[0] || 'ok', 'floor', result.output || result.error.split('\n')[0])
  assert.equal(holderError.trim(), '', holderError)
  assert.equal(result.code, 0, result.error)
  return JSON.parse(result.output)
}

await setup()
try {
  await seedStats()
  await refresh()
  const seeded = await cached()
  assert.equal(Number(seeded[freeAgents[0]]), 20, 'The seeded cache is not the real view average.')
  assert.equal(Number(seeded[freeAgents[1]]), 10, 'The seeded cache is not the real view average.')

  const statsRace = await race(`UPDATE public.player_game_stats SET points = 5 WHERE player_id = ${quote(freeAgents[0])};
    UPDATE public.player_game_stats SET points = 30 WHERE player_id = ${quote(freeAgents[1])}`)
  assert.equal(statsRace.status, 'deferred', `A stats correction during the pass did not defer: ${JSON.stringify(statsRace)}`)
  assert.equal(statsRace.reason, 'averages_pending', `The stats race deferred for the wrong reason: ${JSON.stringify(statsRace)}`)
  assert.equal(await awards(), '0', 'The stats race awarded a free agent from the stale cache.')
  assert.equal(await completed(), '0', 'The stats race completed the week.')

  await refresh()
  const corrected = await cached()
  assert.equal(Number(corrected[freeAgents[0]]), 5, 'The real refresh did not apply the correction.')
  assert.equal(Number(corrected[freeAgents[1]]), 30, 'The real refresh did not apply the correction.')
  const retried = await floor()
  assert.equal(retried.code, 0, retried.error)
  const retriedResult = JSON.parse(retried.output)
  assert.equal(retriedResult.status, 'completed', `The retried floor did not complete: ${retried.output}`)
  assert.equal(await one(`SELECT player_id FROM private.roster_floor_awards WHERE league_id = ${quote(league)}`), freeAgents[1],
    'The retried floor did not award the corrected top player.')

  await one(`DELETE FROM private.roster_floor_awards WHERE league_id = ${quote(league)};
    DELETE FROM public.roster_players WHERE league_id = ${quote(league)} AND acquired_via = 'roster_floor';
    DELETE FROM public.roster_transactions WHERE league_id = ${quote(league)};
    DELETE FROM private.roster_floor_weeks WHERE league_id = ${quote(league)};`)
  await refresh()

  await one(`UPDATE public.player_game_stats SET points = 20 WHERE player_id = ${quote(freeAgents[0])};
    UPDATE public.player_game_stats SET points = 10 WHERE player_id = ${quote(freeAgents[1])};`)
  await refresh()
  const version = await one(`SELECT version FROM private.screen_refresh_queue WHERE league_season_id = ${quote(season)}`)
  const refreshRace = await race(`UPDATE public.player_game_stats SET points = 5 WHERE player_id = ${quote(freeAgents[0])};
    UPDATE public.player_game_stats SET points = 30 WHERE player_id = ${quote(freeAgents[1])};
    SELECT private.refresh_player_averages(${quote(league)}, ${quote(season)}, ${version})`, freeAgents[0])
  assert.equal(refreshRace.status, 'deferred', `A correction and refresh during the pass did not defer: ${JSON.stringify(refreshRace)}`)
  assert.equal(refreshRace.reason, 'averages_pending', `The refresh race deferred for the wrong reason: ${JSON.stringify(refreshRace)}`)
  assert.equal(await awards(), '0', 'The refresh race awarded a free agent from the pre-correction order.')
  assert.equal(await completed(), '0', 'The refresh race completed the week.')
  await one(`DELETE FROM private.roster_floor_awards WHERE league_id = ${quote(league)};
    DELETE FROM public.roster_players WHERE league_id = ${quote(league)} AND acquired_via = 'roster_floor';
    DELETE FROM public.roster_transactions WHERE league_id = ${quote(league)};
    DELETE FROM private.roster_floor_weeks WHERE league_id = ${quote(league)};`)
  await refresh()
  const cleanPass = await floor()
  assert.equal(cleanPass.code, 0, cleanPass.error)
  assert.equal(JSON.parse(cleanPass.output).status, 'completed', `A clean pass did not complete: ${cleanPass.output}`)
  await one(`DELETE FROM private.roster_floor_awards WHERE league_id = ${quote(league)};
    DELETE FROM public.roster_players WHERE league_id = ${quote(league)} AND acquired_via = 'roster_floor';
    DELETE FROM public.roster_transactions WHERE league_id = ${quote(league)};
    DELETE FROM private.roster_floor_weeks WHERE league_id = ${quote(league)};`)
  await refresh()

  const scoringRace = await race(`UPDATE public.leagues SET scoring_settings = jsonb_set(scoring_settings, '{points}', '2') WHERE id = ${quote(league)}`, freeAgents[1])
  assert.equal(scoringRace.status, 'deferred', `A scoring change during the pass did not defer: ${JSON.stringify(scoringRace)}`)
  assert.equal(scoringRace.reason, 'averages_pending', `The scoring race deferred for the wrong reason: ${JSON.stringify(scoringRace)}`)
  assert.equal(await awards(), '0', 'The scoring race awarded a free agent from the stale cache.')
  assert.equal(await completed(), '0', 'The scoring race completed the week.')
  console.log('PASS r5b-averages-race')
} finally {
  await cleanup()
}

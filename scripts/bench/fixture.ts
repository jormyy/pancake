import type { connect } from './request-driver.ts'

export const seed = 6172026
export const id = (value: number) => `617fd6e6-0000-4000-8000-${String(value).padStart(12, '0')}`
export const leagueId = id(1)
export const seasonId = id(2)
export const slots = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']
export type Game = { sourceId: string; time: string; date: string; home: string; away: string; postponed: boolean }
export const positions = [['PG'], ['SG'], ['SF'], ['PF'], ['C'], ['PG', 'SG'], ['SF', 'PF'], ['PF', 'C'], ['PG', 'SF'], ['SG', 'SF']]
export const teams = 'ATL BOS BKN CHA CHI CLE DAL DEN DET GS HOU IND LAC LAL MEM MIA MIL MIN NO NY OKC ORL PHI PHX POR SAC SA TOR UTAH WSH'.split(' ')
export const randomAt = (a: number, b: number) => {
  let value = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0
  value = Math.imul(value ^ value >>> 16, 0x7feb352d) >>> 0
  return (value ^ value >>> 15) >>> 0
}
export const player = (index: number) => ({
  id: id(1000 + index), memberId: id(100 + Math.floor(index / 10)),
  team: teams[(index * 7 + Math.floor(index / 10)) % teams.length], positions: positions[index % 10],
})

export async function seedFixture(sql: ReturnType<typeof connect>, games: Game[]) {
  await sql.unsafe('SET client_min_messages = warning')
  await sql.unsafe('TRUNCATE public.leagues, public.players, public.season_weeks, public.nba_games, auth.users, public.sync_runs, public.edge_invocations, public.projection_sync_runs RESTART IDENTITY CASCADE')
  await sql.unsafe('TRUNCATE bench.requests RESTART IDENTITY')
  const [{ exists }] = await sql`SELECT to_regclass('public.lineup_tipoff_dispatches') IS NOT NULL AS exists`
  if (exists) await sql.unsafe('TRUNCATE public.lineup_tipoff_dispatches CASCADE')
  const firstDate = games[0].date
  const endDate = games.at(-1)!.date
  for (let team = 0; team < 10; team++) {
    await sql`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
      VALUES(${id(10 + team)},'authenticated','authenticated',${`tipoff-${team}@example.test`},'{}',${sql.json({ username: `tipoff_${team}` })})`
  }
  await sql`INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,auction_budget,scoring_settings)
    VALUES(${leagueId},'Tipoff season','tipoff-season',${id(10)},'active',12,200,'{"points":1}'::jsonb)`
  await sql`INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${seasonId},${leagueId},2026,true)`
  await sql`DELETE FROM public.lineup_slot_templates WHERE league_id=${leagueId}`
  for (const slot of slots) await sql`INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${leagueId},${slot},1)`
  for (let team = 0; team < 10; team++) {
    await sql`INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      VALUES(${id(100 + team)},${leagueId},${id(10 + team)},${team === 0 ? 'commissioner' : 'manager'},${`Team ${team + 1}`})`
    await sql`INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled,enabled_at)
      VALUES(${leagueId},${seasonId},${id(100 + team)},true,now())`
  }
  await sql`INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    SELECT 2026, row_number() OVER (ORDER BY d), d::date,(d + interval '6 days')::date
    FROM generate_series(${firstDate}::date,${endDate}::date,interval '7 days') d`
  for (let index = 0; index < 100; index++) {
    const p = player(index)
    await sql`INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions)
      VALUES(${p.id},'Player',${String(index)},${p.team},${p.positions[0]},${p.positions})`
    await sql`INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(${leagueId},${seasonId},${p.memberId},${p.id},'draft')`
  }
  for (const [index, game] of games.entries()) {
    await sql`INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
      SELECT ${id(10000 + index)},${`00225${String(index).padStart(5, '0')}`},2026,week_number,${game.date},${game.home},${game.away},'Scheduled',${game.time}
      FROM public.season_weeks WHERE season_year=2026 AND ${game.date}::date BETWEEN week_start AND week_end`
  }
  const dates = [...new Set(games.map((g) => g.date))]
  for (const [day, date] of dates.entries()) {
    const runId = id(20000 + day)
    await sql`INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,projection_date,started_at,completed_at,status,row_count,matched_count)
      VALUES(${runId},'fantasypros','daily','https://www.fantasypros.com/nba/projections/daily.php',2026,${date},${`${date}T08:00:00Z`},${`${date}T08:00:00Z`},'success',100,100)`
    const rows = Array.from({ length: 100 }, (_, index) => ({
      run_id: runId, projection_type: 'daily', source_url: 'https://www.fantasypros.com/nba/projections/daily.php',
      source_row_number: index + 1, season_year: 2026, projection_date: date, fetched_at: `${date}T08:00:00Z`,
      source_player_name: `Player ${index}`, normalized_player_name: `player ${index}`, player_id: player(index).id,
      match_status: 'matched', points: 5 + randomAt(day, index) % 4500 / 100,
      minutes: 30, rebounds: 0, assists: 0, steals: 0, blocks: 0, three_pointers_made: 0, turnovers: 0,
    }))
    await sql`INSERT INTO public.fantasypros_projection_rows ${sql(rows)}`
  }
  await sql.unsafe('ANALYZE')
}

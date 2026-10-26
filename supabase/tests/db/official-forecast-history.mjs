import assert from 'node:assert/strict'
import { officialForecastHistorySql } from '../../../scripts/season-sim/official-forecast.mjs'
import { assertTarget } from '../../../scripts/season-sim/common.mjs'
import { databaseEnvironment } from '../../../scripts/season-sim/local-stack.mjs'
import { createSqlSession } from '../../../scripts/season-sim/sql-session.mjs'

const target = assertTarget(process.env.SUPABASE_DB_URL, 'db')
assert.equal(target.port, process.env.PANCAKE_TEST_DB_PORT)
const session = createSqlSession('psql', databaseEnvironment(target))
const id = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0')
const c = { seasonYear: 2025, leagueSeasonId: id(1000) }
const matchup = { home_member_id: id(201), away_member_id: id(202) }
const cutoff = '2025-01-10'
const rows = Array.from({ length: 32 }, (_, index) => ({ number: index + 1, player: 101, date: new Date(Date.UTC(2024, 11, index + 1)).toISOString().slice(0, 10), year: 2025 }))
rows.push(
  { number: 40, player: 102, date: '2024-04-01', year: 2024 },
  { number: 41, player: 102, date: '2024-12-31', year: 2025 },
  { number: 50, player: 101, date: cutoff, year: 2025 },
  { number: 51, player: 101, date: '2025-01-11', year: 2025 },
  { number: 52, player: 101, date: '2023-04-01', year: 2023 },
  { number: 53, player: 101, date: '2025-01-09', year: 2025, prefix: '004' },
  { number: 54, player: 101, date: '2025-01-09', year: 2025, status: 'Scheduled' },
  { number: 55, player: 101, date: '2025-01-09', year: 2025, dnp: true },
  { number: 56, player: 103, date: '2025-01-09', year: 2025 },
  { number: 57, player: 104, date: '2025-01-09', year: 2025 },
  { number: 58, player: 105, date: '2025-01-09', year: 2025 },
)
const expected = rows.filter(row => row.number >= 3 && row.number <= 32 || [40, 41].includes(row.number))
function verify(history) {
  assert.equal(history.length, 32)
  assert.deepEqual(history.map(row => row.game_id), expected.map(row => id(row.number)))
  assert.deepEqual(history.map(row => row.game_date), expected.map(row => row.date))
  assert.deepEqual(history.map(row => row.points), expected.map(row => row.number))
  assert.ok(history.every(row => row.game_date < cutoff && row.game_date !== '2030-01-01'))
  assert.deepEqual(history.filter(row => row.player_id === id(101)).map(row => Number(row.recency)), Array.from({ length: 30 }, (_, index) => 30 - index))
}

try {
  await session.query(`BEGIN;
    CREATE TEMP TABLE player_game_stats AS SELECT * FROM public.player_game_stats WITH NO DATA;
    CREATE TEMP TABLE nba_games AS SELECT * FROM public.nba_games WITH NO DATA;
    CREATE TEMP TABLE roster_players AS SELECT * FROM public.roster_players WITH NO DATA;
    INSERT INTO roster_players(player_id,member_id,league_season_id) VALUES
      ('${id(101)}','${id(201)}','${id(1000)}'),('${id(102)}','${id(202)}','${id(1000)}'),
      ('${id(104)}','${id(203)}','${id(1000)}'),('${id(105)}','${id(201)}','${id(1001)}');`)
  for (const row of rows) await session.query(`
    INSERT INTO nba_games(id,game_date,status,nba_game_id,season_year)
      VALUES('${id(row.number)}','${row.date}','${row.status ?? 'Final'}','${row.prefix ?? '002'}${row.number}',${row.year});
    INSERT INTO player_game_stats(id,player_id,game_id,game_date,season_year,points,did_not_play)
      VALUES('${id(row.number + 2000)}','${id(row.player)}','${id(row.number)}','2030-01-01',${row.year},${row.number},${row.dnp ?? false});`)
  const statement = officialForecastHistorySql(c, cutoff, matchup)
  verify(JSON.parse(await session.query(statement)))
  const future = JSON.parse(await session.query(statement.replace(`g.game_date<'${cutoff}'`, 'TRUE')))
  assert.throws(() => verify(future))
  const staleDate = JSON.parse(await session.query(statement.replace("jsonb_build_object('game_date',g.game_date)", "jsonb_build_object('game_date',p.game_date)")))
  assert.throws(() => verify(staleDate))
  console.log(JSON.stringify({ passed: true, inputRows: rows.length, retainedRows: expected.length, perPlayerLimit: 30,
    canonicalGameDate: true, priorAndCurrentSeasons: true, rosterScope: true, nonFinalAndDnpExcluded: true,
    rejectedFutureFilterRemoval: true, rejectedStaleDateSource: true }))
} finally {
  await session.query('ROLLBACK').catch(() => {})
  await session.close()
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { id, quote } from './common.mjs'

const teams = ['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS']
const gameId = number => id(800000 + number)
const nbaId = number => '00299' + String(number).padStart(5, '0')
const playerId = (team, index) => teams.indexOf(team) * 20 + index + 1

export function stateAt(slate, seconds) {
  const elapsed = Math.max(0, Math.min(slate.windowSeconds - 30, seconds))
  const tick = Math.max(0, Math.floor((elapsed - slate.changeOffsetSeconds) / slate.changeEverySeconds) + 1)
  return slate.games.map(game => {
    const finish = (game.startMinute + game.durationMinutes - slate.windowStartMinute) * 60
    const final = elapsed >= finish
    const revision = finish <= 0 ? 0 : Math.min(tick, Math.max(0, Math.ceil((finish - slate.changeOffsetSeconds) / slate.changeEverySeconds)))
    const rows = [game.home, game.away].map((team, side) => Array.from({ length: 12 }, (_, index) => {
      const n = playerId(team, index)
      const points = 5 + (n + slate.seed) % 14 + (index < 6 ? revision : 0)
      const rebounds = (n + 2) % 9
      const assists = (n + 3) % 7
      return { player_id: id(1000 + n), personId: 900000 + n, name: `Synthetic Player ${n}`, played: '1', position: ['PG','SG','SF','PF','C'][index % 5], statistics: {
        points, reboundsTotal: rebounds, reboundsOffensive: Math.min(2, rebounds), reboundsDefensive: Math.max(0, rebounds - 2),
        assists, steals: n % 3, blocks: n % 2, turnovers: n % 4, foulsPersonal: n % 5,
        fieldGoalsMade: 2 + Math.floor(points / 3), fieldGoalsAttempted: 10 + Math.floor(points / 2),
        freeThrowsMade: points % 3, freeThrowsAttempted: points % 3 + 1, threePointersMade: n % 3, threePointersAttempted: n % 3 + 2,
        minutes: 'PT25M00.00S', plusMinusPoints: side ? -3 : 3,
      } }
    }))
    const ageMinutes = Math.max(0, slate.windowStartMinute - game.startMinute)
    const gameElapsed = final ? 2880 : Math.min(2820, Math.floor(ageMinutes * 17 + elapsed))
    const period = final ? 4 : 1 + Math.floor(gameElapsed / 720)
    const clock = final ? 0 : 720 - gameElapsed % 720
    return { ...game, id: gameId(game.number), nba_game_id: nbaId(game.number), revision, gameStatus: final ? 3 : 2,
      gameStatusText: final ? 'Final' : `Q${period} ${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, '0')}`,
      period, gameClock: `PT${Math.floor(clock / 60)}M${String(clock % 60).padStart(2, '0')}.00S`,
      homeTeam: { teamTricode: game.home, score: rows[0].reduce((sum, row) => sum + row.statistics.points, 0), players: rows[0] },
      awayTeam: { teamTricode: game.away, score: rows[1].reduce((sum, row) => sum + row.statistics.points, 0), players: rows[1] } }
  })
}

export function validateSlate(slate) {
  assert.ok(slate.windowSeconds > 120 && slate.windowSeconds <= 1800)
  assert.equal(slate.changeEverySeconds, 20)
  assert.equal(new Set(slate.games.flatMap(game => [game.home, game.away])).size, slate.games.length * 2)
  const maximumLive = Math.max(...Array.from({ length: 300 }, (_, n) => slate.games.filter(game => game.startMinute <= 900 + n && game.startMinute + game.durationMinutes > 900 + n).length))
  if (slate.name === 'training') assert.equal(maximumLive, 5)
  return maximumLive
}

export async function startFeed(stack, slate, anchor) {
  const requests = [], changes = new Map()
  let started = Infinity
  let stopped = Infinity
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${stack.ports.feed}`)
    const seconds = Math.max(0, Math.min(stopped, (Date.now() - started) / 1000))
    const games = stateAt(slate, seconds)
    const revisionTime = new Date(Number.isFinite(stopped) ? Date.now() : Number.isFinite(started) ? started + Math.max(0, (Math.max(...games.map(game => game.revision)) - 1) * 20 + 10) * 1000 : Date.now()).toISOString()
    const make = game => ({ gameId: game.nba_game_id, gameStatus: game.gameStatus, gameStatusText: game.gameStatusText, period: game.period, gameClock: game.gameClock, gameEt: anchor,
      homeTeam: game.homeTeam, awayTeam: game.awayTeam })
    let body, status = 200
    if (url.pathname.endsWith('/todaysScoreboard_00.json')) body = { meta: { time: revisionTime }, scoreboard: { games: games.map(make) } }
    else if (/\/boxscore_[0-9]+\.json$/.test(url.pathname)) {
      const game = games.find(game => url.pathname.endsWith(`boxscore_${game.nba_game_id}.json`))
      if (game) body = { meta: { time: revisionTime }, game: make(game) }
      else { body = { error: 'unknown fixture game' }; status = 404 }
    } else if (url.pathname === '/espn/scoreboard') body = { events: [] }
    else if (url.pathname === '/injuries') body = { injuries: [{ id: '27', injuries: [{ status: 'Out', athlete: { id: '800600', displayName: 'Synthetic Player 600', firstName: 'Synthetic', lastName: 'Player 600', team: { abbreviation: 'WAS' }, position: { abbreviation: 'C' }, experience: { years: 14 } } }] }] }
    else if (url.pathname.endsWith('/scheduleLeagueV2_1.json')) body = { leagueSchedule: { seasonYear: '2026-27', gameDates: [] } }
    else { body = { error: 'No synthetic provider fixture', path: url.pathname }; status = 404 }
    const encoded=JSON.stringify(body)
    requests.push({ bytes:Buffer.byteLength(encoded), at: Date.now(), path: url.pathname, status, revision: Math.max(...games.map(game => game.revision)) })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(encoded)
  })
  await new Promise(resolve => server.listen({ port: stack.ports.feed, host: '127.0.0.1' }, () => resolve(undefined)))
  const address=server.address()
  assert.ok(address && typeof address==='object','The fake feed must bind a TCP port')
  let closing
  return { origin: `http://127.0.0.1:${address.port}`, requests, changes, start(at) { started = at }, freeze(seconds) { stopped = seconds }, close: () => closing ??= new Promise(resolve => server.close(resolve)) }
}

export async function seedSlate(stack, slate, anchor) {
  const date = new Date(anchor).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const year = new Date(anchor).getUTCMonth() >= 7 ? new Date(anchor).getUTCFullYear() + 1 : new Date(anchor).getUTCFullYear()
  await stack.sql(`DELETE FROM public.nba_games WHERE nba_game_id LIKE '00299%';
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
    VALUES ${stateAt(slate, 0).map(game => `(${quote(game.id)},${quote(game.nba_game_id)},${year},2,${quote(date)},${quote(new Date(Date.parse(anchor) + (game.startMinute - slate.windowStartMinute) * 60000).toISOString())},${quote(game.home)},${quote(game.away)},${quote(game.gameStatus === 3 ? 'Final' : 'InProgress')},NULL)`).join(',')};`)
  return { date, year }
}

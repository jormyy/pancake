import http from 'node:http'
import { seasonWeekRows, seasonYearForDate } from './harness/season-calendar.mjs'

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const readJson = async (req) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const isoDuration = (minutes) => {
  const whole = Math.floor(minutes)
  const seconds = Math.round((minutes - whole) * 60)
  return `PT${whole}M${seconds.toString().padStart(2, '0')}.00S`
}

/**
 * @typedef {{
 *   now: string, seasonYear: number, nextRookieId: number, calendarWeeks?: number,
 *   players: [string, any][], games: [string, any][], pushes: any[],
 *   hits: { nbaCdn: number, sleeper: number, push: number }
 * }} FakeUpstreamState
 */

/** @param {{ seasonYear?: number, calendarWeeks?: number }} [options] */
export function createFakeUpstreamServer({ seasonYear = 2027, calendarWeeks = 26 } = {}) {
  /** @type {{ receivedAt: string, body: any }[]} */
  const pushes = []
  const state = {
    now: `${seasonYear - 1}-10-20T12:00:00.000Z`,
    seasonYear,
    calendarWeeks,
    nextRookieId: 900001,
    players: new Map([
      ['1001', { player_id: '1001', first_name: 'Ari', last_name: 'Glass', full_name: 'Ari Glass', team: 'BOS', position: 'PG', age: 25, status: 'Active', injury_status: null, injury_notes: null, active: true, sport: 'nba', years_exp: 4 }],
      ['1002', { player_id: '1002', first_name: 'Ben', last_name: 'Pine', full_name: 'Ben Pine', team: 'NYK', position: 'SG', age: 23, status: 'Active', injury_status: null, injury_notes: null, active: true, sport: 'nba', years_exp: 2 }],
      ['1003', { player_id: '1003', first_name: 'Cy', last_name: 'Oak', full_name: 'Cy Oak', team: 'LAL', position: 'F', age: 21, status: 'Active', injury_status: null, injury_notes: null, active: true, sport: 'nba', years_exp: 0 }],
      ['1004', { player_id: '1004', first_name: 'Dee', last_name: 'Birch', full_name: 'Dee Birch', team: 'BOS', position: 'PG', age: 25, status: 'Active', injury_status: null, injury_notes: null, active: true, sport: 'nba', years_exp: 4 }],
      ['1005', { player_id: '1005', first_name: 'Eli', last_name: 'Cedar', full_name: 'Eli Cedar', team: 'NYK', position: 'SG', age: 23, status: 'Active', injury_status: null, injury_notes: null, active: true, sport: 'nba', years_exp: 2 }],
    ]),
    games: new Map(),
    pushes,
    hits: { nbaCdn: 0, sleeper: 0, push: 0 },
  }

  const seedGame = (id, gameDate, awayTeam, homeTeam) => {
    state.games.set(id, {
      gameId: id,
      gameDate,
      gameEt: `${gameDate}T23:30:00Z`,
      gameStatus: 1,
      period: 1,
      gameClock: 'PT12M00.00S',
      gameStatusText: 'Scheduled',
      awayTeam: { teamTricode: awayTeam, score: 0, players: [] },
      homeTeam: { teamTricode: homeTeam, score: 0, players: [] },
    })
  }

  const setLine = (gameId, teamSide, personId, name, stats) => {
    const game = state.games.get(gameId)
    if (!game) throw new Error(`Unknown game ${gameId}`)
    const team = game[teamSide]
    const player = {
      personId,
      name,
      statistics: {
        assists: stats.assists ?? 0,
        blocks: stats.blocks ?? 0,
        fieldGoalsAttempted: stats.fieldGoalsAttempted ?? 0,
        fieldGoalsMade: stats.fieldGoalsMade ?? 0,
        foulsPersonal: stats.foulsPersonal ?? 0,
        freeThrowsAttempted: stats.freeThrowsAttempted ?? 0,
        freeThrowsMade: stats.freeThrowsMade ?? 0,
        minutes: isoDuration(stats.minutes ?? 0),
        plusMinusPoints: stats.plusMinusPoints ?? 0,
        points: stats.points ?? 0,
        reboundsDefensive: stats.reboundsDefensive ?? 0,
        reboundsOffensive: stats.reboundsOffensive ?? 0,
        reboundsTotal: stats.reboundsTotal ?? 0,
        steals: stats.steals ?? 0,
        threePointersAttempted: stats.threePointersAttempted ?? 0,
        threePointersMade: stats.threePointersMade ?? 0,
        turnovers: stats.turnovers ?? 0,
      },
    }
    const index = team.players.findIndex((p) => String(p.personId) === String(personId))
    if (index === -1) team.players.push(player)
    else team.players[index] = player
  }

  const seedSeason = () => {
    const weeks = seasonWeekRows(state.seasonYear, state.calendarWeeks)
    for (const week of weeks) {
      for (const [index, date] of [week.week_start, week.week_end].entries()) {
        const id = `002${String((state.seasonYear - 1) % 100).padStart(2, '0')}${String((week.week_number - 1) * 2 + index + 1).padStart(5, '0')}`
        seedGame(id, date, 'BOS', index === 0 ? 'NYK' : 'LAL')
        setLine(id, 'awayTeam', 1001, 'Ari Glass', { minutes: 32, points: 24, reboundsTotal: 5, assists: 8, steals: 2, fieldGoalsMade: 9, fieldGoalsAttempted: 18, freeThrowsMade: 3, freeThrowsAttempted: 4, threePointersMade: 3, threePointersAttempted: 7 })
        setLine(id, 'homeTeam', index === 0 ? 1002 : 1003, index === 0 ? 'Ben Pine' : 'Cy Oak', { minutes: 30, points: 18, reboundsTotal: 4, assists: 6, turnovers: 3, fieldGoalsMade: 7, fieldGoalsAttempted: 15, freeThrowsMade: 2, freeThrowsAttempted: 2, threePointersMade: 2, threePointersAttempted: 6 })
      }
    }
  }
  seedSeason()

  const advanceSeason = () => {
    state.seasonYear += 1
    for (const player of state.players.values()) {
      if (typeof player.years_exp === 'number') player.years_exp += 1
      if (typeof player.age === 'number') player.age += 1
    }
    const rookieId = String(state.nextRookieId++)
    state.players.set(rookieId, {
      player_id: rookieId,
      first_name: 'Rookie',
      last_name: String(state.seasonYear),
      full_name: `Rookie ${state.seasonYear}`,
      team: 'UTA',
      position: 'G',
      age: 19,
      status: 'Active',
      injury_status: null,
      injury_notes: null,
      active: true,
      sport: 'nba',
      years_exp: 0,
    })
    seedSeason()
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && (url.pathname.includes('/liveData/') || url.pathname.includes('/staticData/'))) {
        state.hits.nbaCdn += 1
      }

      if (req.method === 'GET' && url.pathname.endsWith('/liveData/scoreboard/todaysScoreboard_00.json')) {
        const today = state.now.slice(0, 10)
        const games = [...state.games.values()].filter((game) => game.gameDate === today)
        return json(res, 200, { scoreboard: { gameDate: today, games } })
      }

      const boxscoreMatch = url.pathname.match(/\/liveData\/boxscore\/boxscore_([^/]+)\.json$/)
      if (req.method === 'GET' && boxscoreMatch) {
        const game = state.games.get(boxscoreMatch[1])
        if (!game) return json(res, 404, { error: 'game_not_found' })
        return json(res, 200, { game })
      }

      const playByPlayMatch = url.pathname.match(/\/liveData\/playbyplay\/playbyplay_([^/]+)\.json$/)
      if (req.method === 'GET' && playByPlayMatch) {
        return json(res, 200, {
          game: {
            gameId: playByPlayMatch[1],
            actions: [
              { actionNumber: 1, actionType: 'period', period: 1, clock: 'PT12M00.00S' },
              { actionNumber: 2, actionType: '2pt', period: 1, clock: 'PT11M40.00S', personId: 1001 },
            ],
          },
        })
      }

      if (req.method === 'GET' && url.pathname.endsWith('/staticData/scheduleLeagueV2_1.json')) {
        const seasonGames = [...state.games.values()]
          .filter((game) => seasonYearForDate(game.gameDate) === state.seasonYear)
          .sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gameId.localeCompare(b.gameId))
        // Like the real feed, number weeks Monday-Sunday from the season's first game week.
        const firstDate = seasonGames[0]?.gameDate
        const dayMs = 24 * 60 * 60 * 1000
        const firstMonday = firstDate ? Date.parse(`${firstDate}T00:00:00Z`) - ((new Date(`${firstDate}T00:00:00Z`).getUTCDay() + 6) % 7) * dayMs : 0
        const weekNumber = (gameDate) => Math.floor((Date.parse(`${gameDate}T00:00:00Z`) - firstMonday) / (7 * dayMs)) + 1
        const gameDates = seasonGames
          .map((game) => ({
            gameDate: game.gameDate,
            games: [{
              gameId: game.gameId,
              weekNumber: weekNumber(game.gameDate),
              gameDateEst: `${game.gameDate}T00:00:00`,
              gameEt: game.gameEt,
              gameStatus: game.gameStatus,
              homeTeam: { teamTricode: game.homeTeam.teamTricode },
              awayTeam: { teamTricode: game.awayTeam.teamTricode },
            }],
          }))
        return json(res, 200, { leagueSchedule: { seasonYear: `${state.seasonYear - 1}-${String(state.seasonYear % 100).padStart(2, '0')}`, gameDates } })
      }

      if (req.method === 'GET' && url.pathname.endsWith('/staticData/playerIndex.json')) {
        return json(res, 200, {
          resultSets: [{
            name: 'PlayerIndex',
            headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'],
            rowSet: [...state.players.values()].map((player) => [
              Number(player.player_id),
              player.first_name,
              player.last_name,
              player.active ? 1 : 0,
            ]),
          }],
        })
      }

      if (req.method === 'GET' && url.pathname === '/v1/players/nba') {
        state.hits.sleeper += 1
        return json(res, 200, Object.fromEntries(state.players))
      }

      if (req.method === 'POST' && url.pathname === '/--/api/v2/push/send') {
        state.hits.push += 1
        const body = await readJson(req)
        const message = {
          receivedAt: new Date().toISOString(),
          body,
        }
        state.pushes.push(message)
        return json(res, 200, { data: { status: 'ok', id: `fake-push-${state.pushes.length}` } })
      }

      if (req.method === 'POST' && url.pathname === '/admin/now') {
        const body = await readJson(req)
        state.now = new Date(body.now).toISOString()
        return json(res, 200, { ok: true, now: state.now })
      }

      if (req.method === 'GET' && url.pathname === '/admin/status') {
        return json(res, 200, { hits: state.hits, pushes: state.pushes.length })
      }

      if (req.method === 'POST' && url.pathname === '/admin/game') {
        const body = await readJson(req)
        const game = state.games.get(body.gameId)
        if (!game) return json(res, 404, { error: 'game_not_found' })
        if (body.status != null) {
          game.gameStatus = body.status
          game.gameStatusText = body.status === 3 ? 'Final' : body.status === 2 ? 'In Progress' : 'Scheduled'
        }
        if (body.period != null) game.period = body.period
        if (body.gameClock != null) game.gameClock = body.gameClock
        if (body.homeScore != null) game.homeTeam.score = body.homeScore
        if (body.awayScore != null) game.awayTeam.score = body.awayScore
        return json(res, 200, { ok: true, game })
      }

      if (req.method === 'POST' && url.pathname === '/admin/player-stat') {
        const body = await readJson(req)
        setLine(body.gameId, body.teamSide, body.personId, body.name, body.stats ?? {})
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/admin/injury') {
        const body = await readJson(req)
        const player = state.players.get(String(body.playerId))
        if (!player) return json(res, 404, { error: 'player_not_found' })
        player.injury_status = body.injuryStatus ?? null
        return json(res, 200, { ok: true, player })
      }

      if (req.method === 'POST' && url.pathname === '/admin/advance-season') {
        advanceSeason()
        return json(res, 200, { ok: true, seasonYear: state.seasonYear })
      }

      if (req.method === 'POST' && url.pathname === '/admin/complete-season') {
        for (const game of state.games.values()) {
          if (seasonYearForDate(game.gameDate) !== state.seasonYear) continue
          game.gameStatus = 3
          game.gameStatusText = 'Final'
          for (const side of ['homeTeam', 'awayTeam']) {
            game[side].score = game[side].players.reduce((sum, player) => sum + player.statistics.points, 0)
          }
        }
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/admin/clear-pushes') {
        state.pushes = []
        return json(res, 200, { ok: true })
      }

      if (req.method === 'GET' && url.pathname === '/admin/pushes') {
        return json(res, 200, { pushes: state.pushes })
      }

      if (req.method === 'GET' && url.pathname === '/admin/state') {
        return json(res, 200, {
          now: state.now,
          seasonYear: state.seasonYear,
          games: [...state.games.values()],
          players: Object.fromEntries(state.players),
          pushes: state.pushes,
        })
      }

      return json(res, 404, { error: 'not_found', path: url.pathname })
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : 'unknown' })
    }
  })

  return {
    state,
    /** Everything the upstream remembers, so a soak shard can hand it to the next one. @returns {FakeUpstreamState} */
    exportState() {
      return structuredClone({
        now: state.now,
        seasonYear: state.seasonYear,
        calendarWeeks: state.calendarWeeks,
        nextRookieId: state.nextRookieId,
        players: [...state.players.entries()],
        games: [...state.games.entries()],
        pushes: state.pushes,
        hits: state.hits,
      })
    },
    /** @param {FakeUpstreamState} saved */
    restoreState(saved) {
      if (!saved || !Array.isArray(saved.players) || !Array.isArray(saved.games) || !Array.isArray(saved.pushes) ||
          typeof saved.now !== 'string' || !Number.isInteger(saved.seasonYear) || !Number.isInteger(saved.nextRookieId) ||
          (saved.calendarWeeks !== undefined && (!Number.isInteger(saved.calendarWeeks) || saved.calendarWeeks < 1)) ||
          ['nbaCdn', 'sleeper', 'push'].some((key) => !Number.isInteger(saved.hits?.[key]))) {
        throw new Error('Fake upstream state is incomplete')
      }
      const copy = structuredClone(saved)
      state.now = copy.now
      state.seasonYear = copy.seasonYear
      state.calendarWeeks = copy.calendarWeeks ?? 26
      state.nextRookieId = copy.nextRookieId
      state.players = new Map(copy.players)
      state.games = new Map(copy.games)
      state.pushes = copy.pushes
      Object.assign(state.hits, copy.hits)
    },
    /** @returns {Promise<http.Server>} */
    listen(port = 4555) {
      return new Promise((resolve) => {
        server.listen(port, () => resolve(server))
      })
    },
    /** @returns {Promise<void>} */
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_UPSTREAM_PORT ?? 4555)
  const fake = createFakeUpstreamServer()
  await fake.listen(port)
  console.log(`[fake-upstream] listening on http://127.0.0.1:${port}`)
}

import http from 'node:http'

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

export function createFakeUpstreamServer() {
  const state = {
    now: '2026-10-20T12:00:00.000Z',
    seasonYear: 2027,
    nextRookieId: 900001,
    players: new Map([
      ['1001', { player_id: '1001', first_name: 'Ari', last_name: 'Glass', full_name: 'Ari Glass', team: 'BOS', position: 'PG', age: 25, status: 'Active', injury_status: null, injury_notes: null, active: true, sport: 'nba', years_exp: 4 }],
      ['1002', { player_id: '1002', first_name: 'Ben', last_name: 'Pine', full_name: 'Ben Pine', team: 'NYK', position: 'SG', age: 23, status: 'Active', injury_status: null, injury_notes: null, active: true, sport: 'nba', years_exp: 2 }],
      ['1003', { player_id: '1003', first_name: 'Cy', last_name: 'Oak', full_name: 'Cy Oak', team: 'LAL', position: 'F', age: 21, status: 'Active', injury_status: null, injury_notes: null, active: true, sport: 'nba', years_exp: 0 }],
    ]),
    games: new Map(),
    pushes: [],
  }

  const seedGame = (id, gameDate, awayTeam, homeTeam) => {
    state.games.set(id, {
      gameId: id,
      gameDate,
      gameEt: `${gameDate}T19:30:00-05:00`,
      gameStatus: 1,
      gameStatusText: 'Scheduled',
      awayTeam: { teamTricode: awayTeam, score: 0, players: [] },
      homeTeam: { teamTricode: homeTeam, score: 0, players: [] },
    })
  }

  seedGame('FAKE0001', '2026-10-20', 'BOS', 'NYK')
  seedGame('FAKE0002', '2026-10-21', 'LAL', 'BOS')

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

  const fallbackGame = (gameId) => ({
    gameId,
    gameDate: state.now.slice(0, 10),
    gameEt: `${state.now.slice(0, 10)}T19:30:00-05:00`,
    gameStatus: 3,
    gameStatusText: 'Final',
    awayTeam: { teamTricode: 'BOS', score: 0, players: [] },
    homeTeam: { teamTricode: 'NYK', score: 0, players: [] },
  })

  setLine('FAKE0001', 'awayTeam', 1001, 'Ari Glass', { minutes: 32, points: 24, reboundsTotal: 5, assists: 8, steals: 2, fieldGoalsMade: 9, fieldGoalsAttempted: 18, freeThrowsMade: 3, freeThrowsAttempted: 4, threePointersMade: 3, threePointersAttempted: 7 })
  setLine('FAKE0001', 'homeTeam', 1002, 'Ben Pine', { minutes: 30, points: 18, reboundsTotal: 4, assists: 6, turnovers: 3, fieldGoalsMade: 7, fieldGoalsAttempted: 15, freeThrowsMade: 2, freeThrowsAttempted: 2, threePointersMade: 2, threePointersAttempted: 6 })

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
    const year = state.seasonYear - 1
    seedGame(`FAKE${state.seasonYear}01`, `${year}-10-20`, 'UTA', 'BOS')
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (req.method === 'GET' && url.pathname.endsWith('/liveData/scoreboard/todaysScoreboard_00.json')) {
        const today = state.now.slice(0, 10)
        const games = [...state.games.values()].filter((game) => game.gameDate === today)
        return json(res, 200, { scoreboard: { gameDate: today, games } })
      }

      const boxscoreMatch = url.pathname.match(/\/liveData\/boxscore\/boxscore_([^/]+)\.json$/)
      if (req.method === 'GET' && boxscoreMatch) {
        const game = state.games.get(boxscoreMatch[1]) ?? fallbackGame(boxscoreMatch[1])
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
        const gameDates = [...state.games.values()].map((game) => ({
          gameDate: game.gameDate,
          games: [{
            gameId: game.gameId,
            gameDateEst: `${game.gameDate}T00:00:00`,
            gameEt: game.gameEt,
            gameStatus: game.gameStatus,
            homeTeam: { teamTricode: game.homeTeam.teamTricode },
            awayTeam: { teamTricode: game.awayTeam.teamTricode },
          }],
        }))
        return json(res, 200, { leagueSchedule: { seasonYear: state.seasonYear, gameDates } })
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
        return json(res, 200, Object.fromEntries(state.players))
      }

      if (req.method === 'POST' && url.pathname === '/--/api/v2/push/send') {
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

      if (req.method === 'POST' && url.pathname === '/admin/game') {
        const body = await readJson(req)
        const game = state.games.get(body.gameId)
        if (!game) return json(res, 404, { error: 'game_not_found' })
        if (body.status != null) {
          game.gameStatus = body.status
          game.gameStatusText = body.status === 3 ? 'Final' : body.status === 2 ? 'In Progress' : 'Scheduled'
        }
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
    listen(port = 4555) {
      return new Promise((resolve) => {
        server.listen(port, () => resolve(server))
      })
    },
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

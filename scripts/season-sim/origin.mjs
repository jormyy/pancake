import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { config, assertTarget, delay, etDate, historicalSummary, laneDirectory, miniRoot, sha256, teamCode } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { orderedActions, snapshot, gameEndTime } from './snapshots.mjs'
import { clockTime } from './virtual-clock.mjs'
import { scheduleObservation } from './schedule-view.mjs'
import { upstreamRecorder } from './recorder.mjs'

function scoreboardTeam(team) {
  return Object.fromEntries(['teamId', 'teamName', 'teamCity', 'teamTricode', 'score'].map(key => [key, team[key]]))
}

export async function startOrigin({ resume = false } = {}) {
  const directory = await laneDirectory(path.join(miniRoot, 'fixtures'))
  const evidence = await laneDirectory(path.join(miniRoot, 'evidence'))
  const store = await fixtureStore(directory)
  const recorder = upstreamRecorder(evidence, { resume })
  const { games } = JSON.parse(await readFile(path.join(directory, 'games.json'), 'utf8'))
  const { games: schedule } = JSON.parse(await readFile(path.join(directory, 'schedule.json'), 'utf8'))
  const nextSource = JSON.parse(await readFile(path.join(directory, 'next-schedule-source.json'), 'utf8'))
  const nextScheduleBytes = await readFile(path.join(directory, nextSource.file))
  assert.equal(sha256(nextScheduleBytes), nextSource.sha256, 'Published next-season schedule hash')
  const boxes = new Map(), plays = new Map(), people = new Map(), teams = new Map(), articles = [], bounds = new Map()
  const now = () => clockTime(JSON.parse(readFileSync(path.join(miniRoot, 'state/clock.json'), 'utf8')), Date.now())
  for (const game of [...games].sort((a, b) => a.time.localeCompare(b.time))) {
    const box = await store.json(`boxscore-${game.id}`)
    boxes.set(game.id, box)
    const actions = orderedActions(await store.json(`playbyplay-${game.id}`))
    bounds.set(game.id, { start: Date.parse(actions[0].timeActual), end: gameEndTime(actions) + 60000 })
    if (game.provenance === 'SYNTHETIC') continue
    const summary = await store.json(`summary-${game.espnId}`)
    articles.push(...historicalSummary(summary, game.time).news)
    for (const side of summary.boxscore?.players ?? []) {
      const code = teamCode(side.team.abbreviation)
      teams.set(String(side.team.id), { id: String(side.team.id), abbreviation: code })
      for (const group of side.statistics ?? []) for (const line of group.athletes ?? []) {
        const athlete = line.athlete
        const team = [box.game.homeTeam, box.game.awayTeam].find(team => team.teamTricode === code)
        const match = team?.players.find(player => player.name === athlete.displayName || player.name === athlete.fullName || `${player.firstName} ${player.familyName}` === athlete.displayName)
        if (!match) continue
        const existing = people.get(String(athlete.id))
        const observation = { time: game.time, date: game.date, team: code, position: athlete.position?.abbreviation ?? match.position ?? null }
        if (existing) existing.observations.push(observation)
        else people.set(String(athlete.id), { id: String(athlete.id), firstName: match.firstName, lastName: match.familyName, fullName: match.name, nbaId: match.personId, observations: [observation] })
      }
    }
  }
  const postponements = new Map()
  for (const entry of schedule.filter(row => row.status === 'STATUS_POSTPONED')) {
    const note = entry.notes.map(note => note.headline).join(' ')
    const match = /Makeup date ([A-Z][a-z]{2}) (\d+)/.exec(note)
    assert.ok(match, `Missing real makeup date: ${entry.espnId}`)
    const date = new Date(`${match[1]} ${match[2]}, ${entry.date.slice(0, 4)} 12:00:00 GMT`).toISOString().slice(0, 10)
    const candidates = games.filter(game => game.date === date && game.home === entry.home && game.away === entry.away)
    assert.equal(candidates.length, 1, `Ambiguous makeup: ${entry.espnId}`)
    postponements.set(candidates[0].id, entry)
  }
  async function view(game, at, withCourt = true) {
    let fault
    try { fault = JSON.parse(readFileSync(path.join(miniRoot, 'state/fault.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (fault?.type === 'out-of-order' && fault.gameId === game.id) at = Date.parse(fault.at)
    if (!plays.has(game.id)) {
      if (plays.size >= 64) plays.delete(plays.keys().next().value)
      plays.set(game.id, await store.json(`playbyplay-${game.id}`))
    }
    const pbp = plays.get(game.id)
    if (at >= bounds.get(game.id).end) return { payload: boxes.get(game.id), provenance: game.provenance === 'SYNTHETIC' ? 'SYNTHETIC' : 'REAL-RAW', key: `boxscore-${game.id}` }
    return { payload: snapshot(boxes.get(game.id), pbp, new Date(at).toISOString(), withCourt), provenance: fault?.gameId === game.id || game.provenance === 'SYNTHETIC' ? 'SYNTHETIC' : 'REAL-DERIVED', key: `playbyplay-${game.id}` }
  }
  function rosterAt(at) {
    const date = etDate(new Date(at).toISOString())
    return [...people.values()].map(person => {
      const observation = person.observations.filter(item => item.date <= date).at(-1) ?? person.observations[0]
      return { ...person, team: observation.team, position: { abbreviation: observation.position }, status: { type: 'active' } }
    })
  }
  const server = /** @type {http.Server & { historicalRoster: () => { espnId: string, nbaTeam: string }[], coverage: typeof recorder.report, flushCoverage: typeof recorder.save }} */ (http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`)
    try {
      assertTarget(url.origin, 'replay')
      assert.equal(request.method, 'GET')
      const at = now(), date = etDate(new Date(at).toISOString())
      let fault
      try { fault = JSON.parse(readFileSync(path.join(miniRoot, 'state/fault.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      const matches = fault?.type === 'http' && url.pathname.startsWith(fault.prefix)
      if (matches && fault.delayMs) await delay(fault.delayMs)
      if (matches && fault.status) {
        response.writeHead(fault.status, { 'Content-Type': 'application/json', 'X-Sim-Provenance': 'SYNTHETIC' })
        response.end(JSON.stringify({ error: 'Seeded synthetic upstream fault' }))
        recorder.record({ path: url.pathname, at, provenance: 'SYNTHETIC', source: fault, status: fault.status })
        return
      }
      let payload, gameEvent = {}, provenance = matches ? 'SYNTHETIC' : 'REAL-DERIVED', source = 'historical game boxes and summaries'
      if (url.pathname === '/health') { payload = { games: games.length, people: people.size, teams: teams.size, at: new Date(at).toISOString() }; provenance = 'SYNTHETIC'; source = 'simulator health metadata' }
      else if (url.pathname === '/static/json/staticData/scheduleLeagueV2_1.json') {
        const rows = games.map(game => scheduleObservation(game, postponements.get(game.id), bounds.get(game.id), at))
        if (fault?.type === 'missing-schedule') { const index = rows.findIndex(row => row.gameId === fault.gameId); assert.ok(index >= 0); rows.splice(index, 1); provenance = 'SYNTHETIC' }
        if (date >= '2026-07-01') {
          response.setHeader('Content-Type', 'application/json')
          response.setHeader('X-Sim-Provenance', 'REAL-RAW')
          response.end(nextScheduleBytes)
          recorder.record({ path: url.pathname, at, provenance: 'REAL-RAW', source: nextSource.file, status: 200 })
          return
        }
        payload = { leagueSchedule: { seasonYear: '2025-26', gameDates: [{ games: rows.filter(row => row.gameId.startsWith('00225')) }] } }
      } else if (url.pathname.endsWith('/todaysScoreboard_00.json')) {
        const selected = await Promise.all(games.filter(game => game.date === date).map(game => view(game, at, false)))
        provenance = selected.some(item => item.provenance === 'SYNTHETIC') ? 'SYNTHETIC' : 'REAL-DERIVED'
        gameEvent = { scoreboardGames: selected.map(item => item.payload.game.gameId) }
        payload = { scoreboard: { gameDate: date, games: selected.map(({ payload: { game } }) => ({ gameId: game.gameId, gameCode: game.gameCode, gameStatus: game.gameStatus, gameStatusText: game.gameStatusText, period: game.period, gameClock: game.gameClock, gameTimeUTC: game.gameTimeUTC, homeTeam: scoreboardTeam(game.homeTeam), awayTeam: scoreboardTeam(game.awayTeam) })) } }
      } else if (/\/boxscore_\d+\.json$/.test(url.pathname)) {
        const id = /boxscore_(\d+)\.json$/.exec(url.pathname)[1]
        const game = games.find(game => game.id === id)
        assert.ok(game, 'Unknown historical game')
        const result = await view(game, at)
        provenance = matches ? 'SYNTHETIC' : result.provenance
        if (fault?.type === 'missing-player' && fault.gameId === id) {
          result.payload = structuredClone(result.payload)
          result.payload.game.homeTeam.players.shift()
          provenance = 'SYNTHETIC'
        }
        source = result.key
        gameEvent = { gameId: id, gameStatus: result.payload.game.gameStatus, period: result.payload.game.period, gameClock: result.payload.game.gameClock, kind: 'boxscore' }
        if (provenance === 'REAL-RAW' || game.provenance === 'SYNTHETIC' && result.payload.game.gameStatus === 3) {
          response.setHeader('Content-Type', 'application/json')
          response.setHeader('X-Sim-Provenance', provenance)
          response.end(await store.bytes(result.key))
          recorder.record({ path: url.pathname, at, provenance, source, status: 200, ...gameEvent })
          return
        }
        payload = result.payload
      } else if (url.pathname === '/espn/teams') payload = { sports: [{ leagues: [{ teams: [...teams.values()].map(team => ({ team })) }] }] }
      else if (/^\/espn\/teams\/\d+\/roster$/.test(url.pathname)) {
        const team = teams.get(url.pathname.split('/')[3])
        payload = { athletes: rosterAt(at).filter(player => player.team === team?.abbreviation) }
      } else if (url.pathname === '/espn/injuries') {
        const latest = new Map()
        for (const game of games.filter(game => game.date <= date).sort((a, b) => a.time.localeCompare(b.time))) {
          for (const team of [boxes.get(game.id).game.homeTeam, boxes.get(game.id).game.awayTeam]) for (const player of team.players) latest.set(player.personId, player)
        }
        payload = { injuries: [{ injuries: [...latest.values()].filter(player => player.notPlayingReason?.includes('INJURY')).map(player => ({ status: 'Out', athlete: { displayName: player.name }, details: player.notPlayingReason })) }] }
      } else if (url.pathname === '/espn/news') payload = { articles: articles.filter(article => Date.parse(article.published) <= at).sort((a, b) => b.published.localeCompare(a.published)).slice(0, Number(url.searchParams.get('limit') ?? 50)) }
      else if (url.pathname === '/static/json/staticData/playerIndex.json') payload = { resultSets: [{ headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: [...people.values()].map(player => [player.nbaId, player.firstName, player.lastName, 1]) }] }
      else if (url.pathname.startsWith('/career/')) {
        payload = { unavailable: 'Historical career totals have not been collected. Unknown remains null.' }
        source = 'documented source gap'
        provenance = 'SYNTHETIC'
      } else if (url.pathname.startsWith('/nba/')) {
        payload = { unavailable: 'Synthetic draft-board overlay uses the real NBA Stats fallback parser.' }
        provenance = 'SYNTHETIC'
        source = 'synthetic rookie eligibility overlay'
      } else if (url.pathname === '/stats/stats/drafthistory') {
        const year = Number(url.searchParams.get('Season'))
        assert.ok([2025, 2026].includes(year))
        payload = { resultSets: [{ headers: ['PLAYER_NAME', 'OVERALL_PICK', 'ROUND_NUMBER', 'ROUND_PICK', 'TEAM_NAME'], rowSet: Array.from({ length: 60 }, (_, index) => [`Synthetic Prospect ${year} ${index + 1}`, index + 1, Math.floor(index / 30) + 1, index % 30 + 1, 'Synthetic team']) }] }
        provenance = 'SYNTHETIC'
        source = 'invented rookie prospects; historical draft and career coverage unavailable'
      } else throw new Error(`Unimplemented historical endpoint: ${url.pathname}`)
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('X-Sim-Provenance', provenance)
      response.end(JSON.stringify(payload))
      recorder.record({ path: url.pathname, at, provenance, source, status: 200, ...gameEvent })
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: error.message }))
      recorder.record({ path: url.pathname, at: now(), provenance: 'SYNTHETIC', source: 'replay transformation error', status: 500, error: error.message })
      console.error(error)
    }
  }))
  await new Promise(resolve => server.listen(config.ports.replay, '127.0.0.1', () => resolve(undefined)))
  console.log(JSON.stringify({ event: 'origin-ready', games: games.length, people: people.size, teams: teams.size }))
  server.historicalRoster = () => rosterAt(now()).map(player => ({ espnId: player.id, nbaTeam: player.team }))
  server.coverage = recorder.report
  server.flushCoverage = recorder.save
  server.on('close', recorder.save)
  return server
}

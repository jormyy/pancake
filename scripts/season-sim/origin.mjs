import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fixtureDirectory, config, assertTarget, delay, etDate, historicalSummary, laneDirectory, miniRoot, season, sha256, teamCode, writeJson } from './common.mjs'
import { fakeExpoRecorder } from './push-origin.mjs'
import { sqlJson } from './local-stack.mjs'
import { fixtureStore } from './fixtures.mjs'
import { orderedActions, snapshot, gameEndTime } from './snapshots.mjs'
import { clockTime } from './virtual-clock.mjs'
import { rosterForDate, playerIndexAt, openingRosters, observeSide, boxTransfers, rosterSourceAudit } from './origin-people.mjs'
import { scheduleObservation } from './schedule-view.mjs'
import { gapSource, unavailableResponse, validGapRoute } from './provider-transport.mjs'
import { upstreamRecorder } from './recorder.mjs'

function scoreboardTeam(team) {
  return Object.fromEntries(['teamId', 'teamName', 'teamCity', 'teamTricode', 'score'].map(key => [key, team[key]]))
}

export async function startOrigin({ resume = false, probeToken = '' } = {}) {
  const directory = fixtureDirectory
  const evidence = await laneDirectory(path.join(miniRoot, 'evidence'))
  const store = await fixtureStore(directory)
  const recorder = upstreamRecorder(evidence, { resume })
  const { games } = JSON.parse(await readFile(path.join(directory, 'games.json'), 'utf8'))
  const { games: schedule } = JSON.parse(await readFile(path.join(directory, 'schedule.json'), 'utf8'))
  const plan = await readFile(path.join(directory, 'two-season-plan.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  const nextSource = plan ? null : JSON.parse(await readFile(path.join(directory, 'next-schedule-source.json'), 'utf8'))
  const nextScheduleBytes = nextSource ? await readFile(path.join(directory, nextSource.file)) : null
  if (nextSource) assert.equal(sha256(nextScheduleBytes), nextSource.sha256, 'Published next-season schedule hash')
  const scheduleSources = new Map()
  if (plan) for (const row of plan.seasons) scheduleSources.set(row.year, await store.json(row.scheduleKey))
  const rosterHistory=plan?JSON.parse(await readFile(path.join(directory,'roster-history.json'),'utf8')).games:[]
  const nbaTeams=new Set(games.flatMap(game=>[game.home,game.away]))
  const summaries = new Map()
  const boxes = new Map(), plays = new Map(), people = new Map(), teams = new Map(), articles = [], bounds = new Map(), transfers = []
  const now = () => clockTime(JSON.parse(readFileSync(path.join(miniRoot, 'state/clock.json'), 'utf8')), Date.now())
  for (const game of [...games,...rosterHistory].sort((a, b) => a.time.localeCompare(b.time))) {
    const box = await store.json(`${game.rosterOnly?'roster-boxscore':'boxscore'}-${game.id}`)
    if(!game.rosterOnly){
      boxes.set(game.id, box)
      const actions = orderedActions(await store.json(`playbyplay-${game.id}`))
      bounds.set(game.id, { start: Date.parse(actions[0].timeActual), end: gameEndTime(actions) + 60000 })
    }
    if (game.provenance === 'SYNTHETIC') continue
    const summary = await store.json(`${game.rosterOnly?'roster-summary':'summary'}-${game.espnId}`)
    if (!game.rosterOnly) summaries.set(game.espnId, { boxscore: { players: (summary.boxscore?.players ?? []).map(team => ({ statistics: (team.statistics ?? []).map(group => ({ names: group.names, athletes: group.athletes.map(row => ({ athlete: { displayName: row.athlete.displayName }, stats: row.stats })) })) })) } })
    articles.push(...historicalSummary(summary, game.time).news)
    for (const side of summary.boxscore?.players ?? []) {
      const code = teamCode(side.team.abbreviation)
      if(!nbaTeams.has(code))continue
      teams.set(String(side.team.id), { id: String(side.team.id), abbreviation: code })
      const team = [box.game.homeTeam, box.game.awayTeam].find(team => team.teamTricode === code)
      const observedGame = process.env.SEASON_SIM_PROFILE && bounds.has(game.id) ? { ...game, time: new Date(bounds.get(game.id).end).toISOString() } : game
      observeSide(people, observedGame, code, team?.players ?? [], (side.statistics ?? []).flatMap(group => group.athletes ?? []).map(line => line.athlete), plan?.firstYears)
    }
    const observedGame = process.env.SEASON_SIM_PROFILE && bounds.has(game.id) ? { ...game, time: new Date(bounds.get(game.id).end).toISOString() } : game
    transfers.push(...boxTransfers(people, observedGame, box))
  }
  const openingGames = process.env.SEASON_SIM_PROFILE ? games.map(game => bounds.has(game.id) ? { ...game, time: new Date(bounds.get(game.id).end).toISOString() } : game) : games
  const openings = openingRosters(openingGames, game => boxes.get(game.id))
  const postponements = new Map()
  for (const entry of (plan ? [] : schedule).filter(row => row.status === 'STATUS_POSTPONED')) {
    const note = entry.notes.map(note => note.headline).join(' ')
    const match = /Makeup date ([A-Z][a-z]{2}) (\d+)/.exec(note)
    assert.ok(match, `Missing real makeup date: ${entry.espnId}`)
    const date = new Date(`${match[1]} ${match[2]}, ${entry.date.slice(0, 4)} 12:00:00 GMT`).toISOString().slice(0, 10)
    const candidates = games.filter(game => game.date === date && game.home === entry.home && game.away === entry.away)
    assert.equal(candidates.length, 1, `Ambiguous makeup: ${entry.espnId}`)
    postponements.set(candidates[0].id, entry)
  }
  if (plan) for (const row of plan.postponements.timelines) postponements.set(row.id, row)
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
    return { payload: snapshot(boxes.get(game.id), pbp, new Date(at).toISOString(), withCourt, summaries.get(game.espnId)), provenance: fault?.gameId === game.id || game.provenance === 'SYNTHETIC' ? 'SYNTHETIC' : 'REAL-DERIVED', key: `playbyplay-${game.id}` }
  }
  function rosterAt(at) {
    return rosterForDate([...people.values()], etDate(new Date(at).toISOString()), openings, process.env.SEASON_SIM_PROFILE ? at : null)
  }
  const expo=await fakeExpoRecorder(evidence,now,async(token,_data,outboxId)=>{
    const quoted=value=>"'"+value.replaceAll("'","''")+"'"
    return sqlJson(`SELECT coalesce(json_agg(o),'[]') FROM (SELECT o.dedupe_key FROM notification_outbox o JOIN league_members m ON m.id=o.member_id JOIN profiles p ON p.id=m.user_id WHERE p.push_token=${quoted(token)} AND o.id::text=${quoted(String(outboxId??''))} AND o.delivered_at IS NULL) o`,'Recorded fake-push outbox identity')
  })
  const server = /** @type {http.Server & { historicalRoster: () => { espnId: string, nbaTeam: string }[], coverage: typeof recorder.report, flushCoverage: typeof recorder.save, onLiveSample?: (sample: { phase: string }) => Promise<void> }} */ (http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`)
    try {
      assertTarget(url.origin, 'replay')
      if(['/push','/receipts'].includes(url.pathname)){
        assert.equal(request.method,'POST')
        const chunks=[]
        for await(const chunk of request)chunks.push(chunk)
        const result=await expo(url.pathname,JSON.parse(Buffer.concat(chunks).toString()))
        response.setHeader('Content-Type','application/json')
        response.end(JSON.stringify(result))
        return
      }
      assert.equal(request.method, 'GET')
      if (url.pathname === '/__sim/live-sample') {
        assert.ok(probeToken && request.headers['x-sim-probe-token'] === probeToken, 'Internal live sampling requires the local runtime token')
        await server.onLiveSample?.({ phase: url.searchParams.get('phase') })
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ ok: true }))
        return
      }
      const recordProvider = (payload, status, at) => appendFileSync(path.join(miniRoot, 'state/provider-responses.jsonl'), `${JSON.stringify({ requestId: request.headers['x-sim-provider-request'], transport: url.href, method: request.method, at: new Date(at).toISOString(), status, bodySha256: sha256(JSON.stringify(payload)), unavailable: payload.unavailable })}\n`)
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
        const profile = plan ? [...plan.seasons].reverse().find(row => date >= `${row.startYear}-08-15`) ?? plan.seasons[0] : season
        const raw = plan ? scheduleSources.get(profile.year).leagueSchedule.gameDates.flatMap(day => day.games) : []
        const metadata = new Map(raw.map(row => [row.gameId, row]))
        const rows = games.filter(game => game.id.startsWith(profile.prefix)).map(game => scheduleObservation(game, postponements.get(game.id), bounds.get(game.id), at, { ...metadata.get(game.id), opening: profile.start }))
        if (fault?.type === 'missing-schedule') { const index = rows.findIndex(row => row.gameId === fault.gameId); assert.ok(index >= 0); rows.splice(index, 1); provenance = 'SYNTHETIC' }
        if (!plan && date >= `${season.year}-07-01`) {
          response.setHeader('Content-Type', 'application/json')
          response.setHeader('X-Sim-Provenance', 'REAL-RAW')
          response.end(nextScheduleBytes)
          recorder.record({ path: url.pathname, at, provenance: 'REAL-RAW', source: nextSource.file, status: 200 })
          return
        }
        payload = { leagueSchedule: { seasonYear: profile.label, gameDates: [{ games: [...rows, ...raw.filter(row => !row.gameId.startsWith(profile.prefix))] }] } }
        if (plan) { source = JSON.stringify({ schedule: profile.scheduleKey, postponements: plan.postponements.provenance, availability: 'SYNTHETIC August 15 release policy; exact original publication time unproven' }); provenance = 'REAL-DERIVED' }
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
        for (const game of games.filter(game => game.date <= date && (!process.env.SEASON_SIM_PROFILE || bounds.get(game.id).end <= at)).sort((a, b) => a.time.localeCompare(b.time))) {
          for (const team of [boxes.get(game.id).game.homeTeam, boxes.get(game.id).game.awayTeam]) for (const player of team.players) latest.set(player.personId, player)
        }
        payload = { injuries: [{ injuries: [...latest.values()].filter(player => player.notPlayingReason?.includes('INJURY')).map(player => ({ status: 'Out', athlete: { displayName: player.name }, details: player.notPlayingReason })) }] }
        if (!payload.injuries[0].injuries.length) payload.unavailable = unavailableResponse('espn-injury-observations', at)
      } else if (url.pathname === '/espn/news') payload = { articles: articles.filter(article => Date.parse(article.published) <= at).sort((a, b) => b.published.localeCompare(a.published)).slice(0, Number(url.searchParams.get('limit') ?? 50)) }
      else if (gapSource(url.pathname)) {
        const provider = gapSource(url.pathname)
        assert.ok(validGapRoute(provider, url), 'Unpinned historical provider route')
        const unavailable = unavailableResponse(provider, at)
        const status = provider === 'espn-career-stats' ? 200 : 503
        response.writeHead(status, { 'Content-Type': 'application/json', 'X-Sim-Provenance': 'HISTORICAL-UNAVAILABLE' })
        recordProvider({ unavailable }, status, at)
        response.end(JSON.stringify({ unavailable }))
        recorder.record({ path: url.pathname, at, provenance: 'HISTORICAL-UNAVAILABLE', source: unavailable, status })
        return
      }
      else if (url.pathname === '/static/json/staticData/playerIndex.json') payload = playerIndexAt([...people.values()], date, openings, process.env.SEASON_SIM_PROFILE ? at : null)
      else if (url.pathname.startsWith('/nba/player/')) throw new Error(`Unimplemented historical endpoint: ${url.pathname}`)
      else if (plan && (url.pathname.startsWith('/nba/') || url.pathname === '/stats/stats/drafthistory')) {
        if(at<Date.parse(plan.draft.availableAt)){
          response.writeHead(503,{'Content-Type':'application/json','X-Sim-Provenance':'SYNTHETIC'})
          const payload = { error: 'Complete pinned draft board unavailable before declared replay availability', unavailable: unavailableResponse('nba-draft-before-publication', at) }
          recordProvider(payload, 503, at)
          response.end(JSON.stringify(payload))
          recorder.record({path:url.pathname,at,provenance:'SYNTHETIC',source:plan.draft.availabilityProvenance,status:503})
          return
        }
        const key = url.pathname === `/nba/news/${plan.draft.year}-nba-draft-order` ? `draft-${plan.draft.year}-news` : url.pathname === `/nba/draft/${plan.draft.year}` ? `draft-${plan.draft.year}-page` : url.pathname === '/stats/stats/drafthistory' && Number(url.searchParams.get('Season')) === plan.draft.year ? `draft-${plan.draft.year}-stats` : null
        assert.ok(key, 'An unpinned real draft route cannot return synthetic prospects')
        response.setHeader('Content-Type', key.endsWith('-stats') ? 'application/json' : 'text/html')
        response.setHeader('X-Sim-Provenance', 'REAL-RAW')
        response.end(await store.bytes(key))
        recorder.record({ path: url.pathname, at, provenance: 'REAL-RAW', source: { key, availability: plan.draft.availabilityProvenance }, status: 200 })
        return
      } else if (url.pathname.startsWith('/nba/')) {
        payload = { unavailable: 'Synthetic draft-board overlay uses the real NBA Stats fallback parser.' }
        provenance = 'SYNTHETIC'
        source = 'synthetic rookie eligibility overlay'
      } else if (url.pathname === '/stats/stats/drafthistory') {
        const year = Number(url.searchParams.get('Season'))
        assert.ok([season.startYear, season.year].includes(year))
        payload = { resultSets: [{ headers: ['PLAYER_NAME', 'OVERALL_PICK', 'ROUND_NUMBER', 'ROUND_PICK', 'TEAM_NAME'], rowSet: Array.from({ length: 60 }, (_, index) => [`Synthetic Prospect ${year} ${index + 1}`, index + 1, Math.floor(index / 30) + 1, index % 30 + 1, 'Synthetic team']) }] }
        provenance = 'SYNTHETIC'
        source = 'invented rookie prospects; historical draft and career coverage unavailable'
      } else throw new Error(`Unimplemented historical endpoint: ${url.pathname}`)
      if (games.some(game => game.provenance === 'SYNTHETIC' && game.date <= date) && (url.pathname === '/espn/injuries' || /^\/espn\/teams\/\d+\/roster$/.test(url.pathname))) {
        provenance = 'SYNTHETIC'
        source = 'Roster and injury observations include synthetic next-season mappings'
      }
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('X-Sim-Provenance', provenance)
      if (payload.unavailable?.source === 'espn-injury-observations') recordProvider(payload, 200, at)
      response.end(JSON.stringify(payload))
      recorder.record({ path: url.pathname, at, provenance, source, status: 200, ...gameEvent })
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: error.message }))
      recorder.record({ path: url.pathname, at: now(), provenance: 'SYNTHETIC', source: 'replay transformation error', status: 500, error: error.message })
      console.error(error)
    }
  }))
  await writeJson(path.join(evidence,'roster-source-audit.json'),{businessAt:new Date(now()).toISOString(),provenance:'REAL-DERIVED from dated NBA/ESPN boxes, opening-night NBA boxes, NBA box listings of moved players and historical NBA first-season metadata',people:people.size,...rosterSourceAudit([...people.values()],etDate(new Date(now()).toISOString()),openings),boxTransfers:transfers})
  await new Promise(resolve => server.listen(config.ports.replay, '127.0.0.1', () => resolve(undefined)))
  console.log(JSON.stringify({ event: 'origin-ready', games: games.length, people: people.size, teams: teams.size }))
  server.historicalRoster = () => rosterAt(now()).map(player => ({ espnId: player.id, nbaTeam: player.team }))
  server.coverage = recorder.report
  server.flushCoverage = recorder.save
  server.on('close', recorder.save)
  return server
}

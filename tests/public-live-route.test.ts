import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createLiveHandler } from '../server/live/handler'

const now = Date.parse('2026-10-31T23:00:05Z')
const date = '2026-10-31'
const stats = { points: 5, reboundsTotal: 1, reboundsOffensive: 0, reboundsDefensive: 1, assists: 1, steals: 0, blocks: 0,
  turnovers: 0, threePointersMade: 1, threePointersAttempted: 2, fieldGoalsMade: 2, fieldGoalsAttempted: 4,
  freeThrowsMade: 0, freeThrowsAttempted: 0, foulsPersonal: 0, plusMinusPoints: 0, minutes: 'PT5M00S' }
const box = { gameId: '0022600001', gameEt: '2026-10-31T19:00:00-04:00', gameStatus: 2, gameStatusText: 'Q1', period: 1, gameClock: 'PT07M00S',
  homeTeam: { teamTricode: 'BOS', score: 5, players: [{ personId: 10, name: 'Public player', played: 1, statistics: stats }] },
  awayTeam: { teamTricode: 'NYK', score: 5, players: [{ personId: 11, name: 'Public player', played: 1, statistics: stats }] } }
const event = { id:'4001',date:'2026-10-31T23:00:00Z',season:{type:2,year:2027},
  status:{period:1,displayClock:'7:00',type:{state:'in'}},competitions:[{date:'2026-10-31T23:00:00Z',
    status:{period:1,displayClock:'7:00',type:{state:'in'}},competitors:[
      {homeAway:'home',score:'5',team:{abbreviation:'BOS'}},{homeAway:'away',score:'5',team:{abbreviation:'NY'}}]}] }

function summary(source = event) {
  return {header:{id:source.id,season:source.season,competitions:[{...source.competitions[0],status:source.status}]},
    meta:{lastUpdatedAt:new Date(now).toISOString()},boxscore:{players:['BOS','NY'].map((team,index)=>({team:{abbreviation:team},statistics:[{
      names:['PTS','REB','AST','STL','BLK','TO','PF','OREB','DREB','+/-','FG','3PT','FT','MIN'],athletes:[{
        athlete:{id:String(20+index),displayName:'Player'},didNotPlay:false,stats:[source.competitions[0].competitors[index].score,'1','1','0','0','0','0','0','1','0','2-4','1-2','0-0','5:00'],
      }]}]}))} }
}

async function sourceSelection(source: typeof event, nbaTime = now, nbaBox = box) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push(url.pathname)
    if (url.hostname === 'site.api.espn.com') return Response.json(url.pathname.endsWith('scoreboard') ? {events:[source]} : summary(source))
    return Response.json(url.pathname.includes('scoreboard')
      ? {meta:{time:new Date(nbaTime).toISOString()},scoreboard:{games:[nbaBox]}}
      : {meta:{time:new Date(nbaTime).toISOString()},game:nbaBox})
  })
  const response = await createLiveHandler({now:()=>now})(new Request(`http://local/api/live/${date}`))
  return {response,body:await response.json(),calls}
}

afterEach(() => vi.unstubAllGlobals())

describe('public live route', () => {
  it('skips the large ESPN summary when a current NBA box agrees with its scoreboard', async () => {
    const result = await sourceSelection(structuredClone(event))
    expect(result.body.games[0].source).toBe('nba')
    expect(result.calls.some(path=>path.endsWith('/summary'))).toBe(false)
    expect(result.calls).toHaveLength(3)
  })

  it('reads ESPN when the NBA source is old or the scoreboard is ahead', async () => {
    const old = await sourceSelection(structuredClone(event),now-20000)
    expect(old.calls.some(path=>path.endsWith('/summary'))).toBe(true)
    expect(old.body.games[0].source).toBe('espn')
    const ahead = structuredClone(event)
    ahead.status.displayClock = '6:30'
    ahead.competitions[0].competitors[0].score = '6'
    const result = await sourceSelection(ahead,now-1000)
    expect(result.calls.some(path=>path.endsWith('/summary'))).toBe(true)
    expect(result.body.games[0].home.score).toBe(6)
    expect(result.body.games[0].source).toBe('espn')
  })

  it('keeps a complete NBA final without reading an ESPN summary', async () => {
    const final = {...structuredClone(box),gameStatus:3}
    const result = await sourceSelection(structuredClone(event),now-600000,final)
    expect(result.body.games[0]).toMatchObject({source:'nba',status:'Final'})
    expect(result.calls.some(path=>path.endsWith('/summary'))).toBe(false)
  })

  it('uses ESPN when an NBA player line is incomplete even if team points still agree', async () => {
    const incomplete = structuredClone(box)
    delete (incomplete.homeTeam.players[0].statistics as Partial<typeof stats>).reboundsTotal
    const result = await sourceSelection(structuredClone(event),now,incomplete)
    expect(result.body.games[0].source).toBe('espn')
  })
  it('returns only compact public source data and cache headers without any database request', async () => {
    const requests: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests.push(url)
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      if (url.hostname === 'site.api.espn.com') return Response.json({ events: [] })
      expect(url.hostname).toBe('cdn.nba.com')
      return Response.json(url.pathname.includes('scoreboard')
        ? { meta: { time: new Date(now).toISOString() }, scoreboard: { games: [box] } }
        : { meta: { time: new Date(now).toISOString() }, game: box })
    })
    const response = await createLiveHandler({ now: () => now })(new Request(`http://local/api/live/${date}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('s-maxage=30')
    expect(response.headers.get('cache-control')).toContain('stale-while-revalidate=15')
    expect(response.headers.get('cache-control')).toContain('stale-if-error=90')
    expect(response.headers.has('set-cookie')).toBe(false)
    const text = await response.text()
    const result = JSON.parse(text)
    expect(result.games[0]).toMatchObject({ nbaId: box.gameId, source: 'nba', status: 'InProgress' })
    expect(result.games[0].home.players[0]).toHaveLength(15)
    expect(text).not.toMatch(/Public player|memberId|leagueId|playerId|supabase|authorization/i)
    expect(requests).toHaveLength(3)
    expect(new TextEncoder().encode(text).length).toBeLessThan(10000)
  })

  it('uses the existing ESPN parser when NBA is unavailable', async () => {
    const board = JSON.parse(readFileSync('tests/fixtures/live-espn/2026-10-30T01-00-49.445Z-scoreboard.json','utf8')).payload
    board.events = board.events.filter((event: { id: string }) => event.id === '401909893')
    const summary = JSON.parse(readFileSync('tests/fixtures/live-espn/2026-10-30T01-00-49.554Z-summary-401909893.json','utf8')).payload
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.hostname === 'cdn.nba.com') return Response.json({}, {status:403})
      expect(url.hostname).toBe('site.api.espn.com')
      return Response.json(url.pathname.endsWith('scoreboard') ? board : summary)
    })
    const handler = createLiveHandler({ now: () => Date.parse('2026-10-30T01:00:49.554Z') })
    const response = await handler(new Request('http://local/api/live/2026-10-29'))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.games[0]).toMatchObject({ source: 'espn', espnId: '401909893', nbaId: null, status: 'InProgress' })
    expect(result.games[0].home.players.length).toBeGreaterThan(5)
  })

  it('the server off switch avoids provider fetches and selects the previous path', async () => {
    const source = vi.fn()
    const response = await createLiveHandler({ now: () => now, disabled: () => true, source })(new Request(`http://local/api/live/${date}`))
    expect((await response.json()).mode).toBe('database')
    expect(source).not.toHaveBeenCalled()
  })

  it('rejects unbounded dates, query variants, and write methods before provider work', async () => {
    const source = vi.fn()
    const handler = createLiveHandler({ now: () => now, source })
    expect((await handler(new Request('http://local/api/live/2000-01-01'))).status).toBe(400)
    expect((await handler(new Request(`http://local/api/live/${date}?random=1`))).status).toBe(400)
    expect((await handler(new Request(`http://local/api/live/${date}`, {method:'POST'}))).status).toBe(405)
    expect(source).not.toHaveBeenCalled()
  })

  it('returns a cache-safe error on source failure', async () => {
    const response = await createLiveHandler({ now: () => now, source: async () => { throw new Error('provider details') } })(new Request(`http://local/api/live/${date}`))
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain('provider details')
  })

  it('bounds an origin fallback when the CDN does not support stale-if-error', async () => {
    let clock = now
    let failed = false
    const source = async () => {
      if (failed) throw new Error('outage')
      return { version: 1 as const, mode: 'public' as const, date, capturedAt: clock, games: [] }
    }
    const handler = createLiveHandler({ now: () => clock, source })
    const request = () => new Request(`http://local/api/live/${date}`)
    await handler(request())
    failed = true
    clock += 46000
    const fallback = await handler(request())
    expect(fallback.status).toBe(200)
    expect((await fallback.json()).capturedAt).toBe(now)
    expect(fallback.headers.get('cache-control')).toContain('s-maxage=30')
    clock = now + 119001
    expect((await handler(request())).headers.get('cache-control')).toContain('s-maxage=1')
    clock = now + 120001
    expect((await handler(request())).status).toBe(503)
  })

  it('coalesces concurrent origin requests and caps response size below platform limits', async () => {
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const source = vi.fn(async () => { await wait; return { version: 1 as const, mode: 'public' as const, date, capturedAt: now, games: [] } })
    const handler = createLiveHandler({ now: () => now, source })
    const requests = [handler(new Request(`http://local/api/live/${date}`)),handler(new Request(`http://local/api/live/${date}`))]
    release()
    expect((await Promise.all(requests)).every(response => response.ok)).toBe(true)
    expect(source).toHaveBeenCalledTimes(1)
    const large = createLiveHandler({ now: () => now, source: async () => ({ version: 1,mode:'public',date,capturedAt:now,games:[],padding:'x'.repeat(1000000) }) })
    expect((await large(new Request(`http://local/api/live/${date}`))).status).toBe(503)
  })

  it('routes the function before the static application fallback', () => {
    const config = JSON.parse(readFileSync('vercel.json','utf8'))
    expect(config.functions['api/live/[date].ts'].maxDuration).toBe(10)
    const api = config.routes.findIndex((row: { dest?: string }) => row.dest?.startsWith('/api/live/'))
    const fallback = config.routes.findIndex((row: { dest?: string }) => row.dest === '/+not-found.html')
    expect(api).toBeGreaterThanOrEqual(0)
    expect(api).toBeLessThan(fallback)
  })
})

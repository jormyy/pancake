import assert from 'node:assert/strict'
import { createWorld, handler, ids, rows, sql } from './identity-rank-projection-fixture.ts'

type Page = { file: string; snapshot: number; view: string; sha256: string; bytes: number; expected: { pick: number; name: string; rank: number }[] }
type Rank = { source: string; source_rank: number; player_id: string | null; source_player_name: string; rank_change: number; games_played: number; points: number; fetched_at: string }
type Forecast = { player_id: string; five_year_rank: number; three_year_rank: number; rookie_rank: number; games_played: number | null; avg_fantasy_points: number | null }
const manifest = JSON.parse(await Deno.readTextFile(new URL('../../functions/sync-rankings/fixtures/rookies-2025-manifest.json', import.meta.url))) as { provenance: string; pages: Page[] }
const world = await createWorld()
const pages = new Map<string, string>()
let snapshot = 1
const requests: { method: string; view: string; snapshot: number }[] = []
let server: Deno.HttpServer<Deno.NetAddr> | undefined
try {
  for (const page of manifest.pages) {
    const compressed = await Deno.readFile(new URL(`../../functions/sync-rankings/fixtures/${page.file}`, import.meta.url))
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
    const raw = new Uint8Array(await new Response(stream).arrayBuffer())
    assert.equal(raw.length, page.bytes)
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    assert.equal(digest, page.sha256)
    pages.set(`${page.view}-${page.snapshot}`, new TextDecoder().decode(raw))
  }
  server = Deno.serve({ hostname: '127.0.0.1', port: 57780, onListen() {} }, async request => {
    assert.equal(new URL(request.url).pathname, '/fantasy-basketball-dynasty-rankings')
    let view = 'POINT_5'
    if (request.method === 'POST') {
      const form = new URLSearchParams(await request.text())
      assert.equal(form.get('__VIEWSTATE'), `synthetic-${snapshot}`)
      view = form.get('ctl00$ContentPlaceHolder1$DDTYPE') === 'ROOKIE' ? 'ROOKIE'
        : Number(form.get('ctl00$ContentPlaceHolder1$DDFORECAST')) === 3 ? 'POINT_3' : 'POINT_5'
    }
    requests.push({ method: request.method, view, snapshot })
    return new Response(pages.get(`${view}-${snapshot}`), { headers: { 'Content-Type': 'text/html' } })
  })
  const origin = `http://127.0.0.1:${server.addr.port}`
  world.origins.add(origin)
  Deno.env.set('HASHTAG_BASE_URL', origin)
  await world.store(false)
  const run = await handler(new URL('../../functions/sync-rankings/index.ts', import.meta.url).href)
  const sources = { POINT_5: 'hashtagbasketball.com', POINT_3: 'hashtagbasketball.com/points-3', ROOKIE: 'hashtagbasketball.com/rookie' }
  const evidence: unknown[] = []
  const sync = async () => {
    for (const view of ['POINT_3', 'ROOKIE', 'POINT_5']) {
      const result = await run({ view })
      assert.equal(result.view, view)
      assert.equal(result.rows, view === 'ROOKIE' ? 59 : 300)
    }
  }
  const check = async (phase: string) => {
    const actual = await rows<Rank>('SELECT * FROM dynasty_rankings')
    for (const [view, source] of Object.entries(sources)) {
      const page = manifest.pages.find(page => page.view === view && page.snapshot === snapshot)!
      for (const expected of page.expected) {
        const matches = actual.filter(row => row.source === source && row.player_id === world.byPick.get(expected.pick))
        assert.equal(matches.length, 1, `${phase}: ${view}: ${expected.name} must link exactly once`)
        assert.equal(matches[0].source_rank, expected.rank)
        assert.equal(matches[0].games_played, snapshot === 1 ? 5 : 9)
        assert.equal(matches[0].points, snapshot === 1 ? 10 : 20)
        assert.equal(matches[0].rank_change, snapshot === 1 ? 0 : 2)
        assert.equal(matches[0].fetched_at.slice(0,10), snapshot === 1 ? '2026-04-12' : '2026-04-13')
      }
    }
    assert.equal(await sql("SELECT count(*) FROM dynasty_rankings WHERE source='hashtagbasketball.com/rookie' AND player_id IS NULL"), '0', 'No drafted rookie may appear in the real unmatched-rookie query')
    const players = await rows<{ id: string; dynasty_rank: number }>(`SELECT id,dynasty_rank FROM players WHERE id IN (${ids(world.byPick.values())})`)
    const five = manifest.pages.find(page => page.view === 'POINT_5' && page.snapshot === snapshot)!
    for (const expected of five.expected) assert.equal(players.find(player => player.id === world.byPick.get(expected.pick))?.dynasty_rank, expected.rank, `${phase}: canonical player rank`)
    await sql('SELECT refresh_player_search_caches()')
    const forecast = await world.forecast<Forecast>()
    assert.equal(forecast.length, world.picks.length)
    assert.equal(new Set(forecast.map(row => row.player_id)).size, world.picks.length)
    for (const pick of world.picks) {
      const row = forecast.find(row => row.player_id === world.byPick.get(pick.pick))!
      assert.ok(row, `${phase}: missing forecast for ${pick.name}`)
      for (const [view, field] of [['POINT_5','five_year_rank'],['POINT_3','three_year_rank'],['ROOKIE','rookie_rank']] as const) {
        const expected = manifest.pages.find(page => page.view === view && page.snapshot === snapshot)!.expected.find(row => row.pick === pick.pick)!
        assert.equal(row[field], expected.rank)
      }
      const games = (pick.games ?? []).filter(game => game.played === '1')
      if (games.length) {
        const sample = snapshot === 1 ? games.slice(0,1) : games
        assert.equal(row.games_played, sample.length)
        assert.notEqual(row.avg_fantasy_points, null)
        assert.equal(Number(row.avg_fantasy_points), Number((sample.reduce((sum, game) => sum + game.stats.points,0) / sample.length).toFixed(2)), `${phase}: real game production for ${pick.name}`)
      }
    }
    evidence.push({ phase, snapshot, drafted: world.picks.length, views: 3, matchedRows: 177, forecastRows: forecast.length, unmatchedRookies: 0 })
  }
  await sync()
  await check('before-nba-link')
  await world.link()
  await check('after-nba-link')
  await world.store(true)
  await world.advance()
  snapshot = 2
  await sync()
  await check('after-second-dated-snapshot-and-real-games')
  const merge = await world.merge()
  await check('after-forced-merge')
  assert.ok(requests.length === 12 && requests.filter(request => request.method === 'POST').length === 6)
  console.log(JSON.stringify({ provenance: manifest.provenance, gameProvenance: 'REAL-DERIVED', calendar: 'SYNTHETIC long test week, identity/update scope only', evidence, requests, merge }))
} finally {
  if (server) await server.shutdown()
  Deno.env.delete('HASHTAG_BASE_URL')
  await world.cleanup()
}

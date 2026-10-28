import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { apiTarget, databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

if (!globalThis.Deno) {
  const browser = process.argv.includes('--browser')
  execFileSync('deno', ['run', '--no-lock', '--allow-env', '--allow-read', '--allow-write',
    '--allow-run=supabase,psql', '--allow-net=127.0.0.1,localhost', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit', env: browser ? { ...process.env, HASHTAG_KEEP_FIXTURE: '1' } : process.env,
  })
  if (browser) {
    const { verifyHashtagBrowser } = await import('./hashtag-rankings-browser.mjs')
    await verifyHashtagBrowser()
  }
} else {
  await verifyRankings()
}

async function verifyRankings() {
  const config = readFileSync('supabase/config.toml', 'utf8')
  const project = process.env.HASHTAG_TEST_PROJECT ?? 'pt4bafableht'
  assert.equal(config.match(/^project_id = "([^"]+)"$/m)?.[1], project)
  const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const api = apiTarget({ SUPABASE_URL: status.API_URL, PANCAKE_TEST_API_PORT: process.env.PANCAKE_TEST_API_PORT ?? '59021' })
  databaseTarget({ SUPABASE_DB_URL: status.DB_URL, PANCAKE_TEST_DB_PORT: process.env.PANCAKE_TEST_DB_PORT ?? '59022' })
  const sql = query => execFileSync('psql', [status.DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: query, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trim()
  const json = query => JSON.parse(sql(query))
  const nativeFetch = globalThis.fetch
  const fixtureOrigin = 'http://127.0.0.1:59089'
  const token = 'local-hashtag-regression'
  globalThis.Deno.env.set('SUPABASE_URL', status.API_URL)
  globalThis.Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', status.SECRET_KEY ?? status.SERVICE_ROLE_KEY)
  globalThis.Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', token)
  globalThis.Deno.env.set('HASHTAG_BASE_URL', fixtureOrigin)
  const shared = '../../supabase/functions/_shared/'
  const rankings = '../../supabase/functions/sync-rankings/'
  const { supabase } = await import(shared + 'supabase.ts')
  const { parseTradeValues, syncTradeValues } = await import(shared + 'tradeValues.ts')
  const { parseDynastyRankingsHtml } = await import(rankings + 'parser.ts')
  const { buildDynastyRankingPayload } = await import(rankings + 'match.ts')
  const { RANKING_VIEWS_IN_WRITE_ORDER } = await import(rankings + 'views.ts')
  const cheerioModule = 'npm:cheerio@1.2.0'
  const { load } = await import(cheerioModule)
  const must = async promise => {
    const { data, error } = await promise
    if (error) throw error
    return data
  }
  const rpc = (name, args) => must(supabase.rpc(name, args))
  const pages = new Map()
  for (const view of RANKING_VIEWS_IN_WRITE_ORDER) {
    const page = gunzipSync(readFileSync(`supabase/functions/sync-rankings/fixtures/rookies-2025-${view.type.toLowerCase()}-1.html.gz`)).toString()
    const $ = load(page)
    const body = $('table.table--statistics').first().children('tbody')
    const rows = body.children('tr')
    const count = view.type === 'ROOKIE' ? 52 : 400
    if (rows.length > count) rows.slice(count).remove()
    const maxRank = Math.max(...parseDynastyRankingsHtml(page).map(row => row.rank))
    for (let index = rows.length; index < count; index++) {
      const clone = rows.last().clone()
      clone.children('td').first().find('span').first().text(`#${maxRank + index - rows.length + 1}`)
      clone.children('td').eq(1).html(`Synthetic Reserve ${index}<input type="hidden" value="reserve-${index}">`)
      body.append(clone)
    }
    if (view.type === 'POINT_3') {
      body.children('tr').first().find('td').filter((_, element) => $(element).find('.lbl').text() === 'PTS').html('12<span class="lbl">PTS</span>')
    }
    pages.set(view.type, $.html())
    assert.equal(parseDynastyRankingsHtml($.html()).length, count)
  }
  const postViews = []
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin === fixtureOrigin) {
      const form = new URLSearchParams(String(init?.body ?? ''))
      const view = init?.method === 'POST'
        ? form.get('ctl00$ContentPlaceHolder1$DDTYPE') === 'ROOKIE' ? 'ROOKIE' : `POINT_${form.get('ctl00$ContentPlaceHolder1$DDFORECAST')}`
        : 'POINT_5'
      if (init?.method === 'POST') postViews.push(view)
      assert.ok(pages.has(view), `Unexpected Hashtag form selection: ${view}`)
      return Promise.resolve(new Response(pages.get(view), { headers: { 'content-type': 'text/html' } }))
    }
    assert.equal(url.origin, api.origin, 'Only the private API may receive requests')
    return nativeFetch(input, init)
  }
  const source = readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')
  const tradePlayers = parseTradeValues(source).filter(row => row.kind === 'player')
  const sourcePlayers = new Map(tradePlayers.map(row => [row.name, { name: row.name, team: row.team, positions: row.positions }]))
  for (const html of pages.values()) {
    for (const row of parseDynastyRankingsHtml(html)) {
      if (!sourcePlayers.has(row.name)) sourcePlayers.set(row.name, { name: row.name, team: row.team, positions: row.positions })
    }
  }
  const playerRows = [...sourcePlayers.values()].map((row, index) => ({
    sportsdata_id: `hashtag-regression-${index}`, first_name: row.name.split(' ')[0], last_name: row.name.split(' ').slice(1).join(' '), nba_team: row.team,
    position: row.positions[0], eligible_positions: row.positions, status: 'Active', years_exp: 0,
  }))
  const players = await must(supabase.from('players').upsert(playerRows, { onConflict: 'sportsdata_id' })
    .select('id,display_name,sportsdata_id,sleeper_id,nba_id,nba_team,status,position,eligible_positions'))
  const staleAt = '2026-10-27T23:00:00Z'
  for (const view of RANKING_VIEWS_IN_WRITE_ORDER) {
    const payload = buildDynastyRankingPayload(parseDynastyRankingsHtml(pages.get(view.type)), players, staleAt, view.source)
    await must(supabase.from('dynasty_rankings').upsert(payload.rows, { onConflict: 'source,source_rank' }))
  }
  const publish = () => syncTradeValues({
    players: async () => players, overrides: async () => ({}),
    publish: payload => rpc('publish_trade_values', { p_rows: payload.rows, p_picks: payload.picks,
      p_source_body: payload.source, p_fetched_at: payload.fetchedAt, p_mode: payload.mode, p_request_id: payload.requestId }),
  }, { format: 'json', content: source })
  await publish()
  const marketBefore = json("SELECT jsonb_agg(to_jsonb(r) ORDER BY source_rank) FROM public.dynasty_rankings r WHERE source='onenumberhoops.com'")
  const picksBefore = json('SELECT jsonb_agg(to_jsonb(p) ORDER BY draft_year,round,tier) FROM public.dynasty_pick_values p')
  assert.equal(marketBefore.length, 450)
  assert.ok(marketBefore.filter(row => row.player_id).length > 400)
  assert.equal(picksBefore.length, 27)
  let worker = async request => new Response(request.url, { status: 503 })
  const originalServe = globalThis.Deno.serve
  globalThis.Deno.serve = handler => { worker = handler }
  await import(rankings + 'index.ts')
  globalThis.Deno.serve = originalServe
  for (const view of RANKING_VIEWS_IN_WRITE_ORDER) {
    const response = await worker(new Request(`${status.API_URL}/functions/v1/sync-rankings`, {
      method: 'POST', headers: { 'x-internal-function-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ view: view.type }),
    }))
    assert.equal(response.status, 200, `${view.type}: ${await response.clone().text()}`)
    const result = await response.json()
    const stored = await must(supabase.from('dynasty_rankings').select('source,scoring_format,points,player_id,fetched_at,source_metadata')
      .eq('source', view.source))
    assert.equal(result.rows, view.type === 'ROOKIE' ? 52 : 400)
    assert.equal(stored.length, result.rows)
    assert.ok(stored.every(row => row.fetched_at > staleAt && row.source_metadata.forecastSeasons === view.forecastSeasons))
    assert.ok(stored.filter(row => row.player_id).length > 40)
    if (view.type !== 'ROOKIE') assert.ok(stored.every(row => row.points > 0 && row.scoring_format === 'points'))
  }
  assert.deepEqual(postViews, ['POINT_3', 'ROOKIE', 'POINT_5'])
  assert.deepEqual(json("SELECT jsonb_agg(to_jsonb(r) ORDER BY source_rank) FROM public.dynasty_rankings r WHERE source='onenumberhoops.com'"), marketBefore)
  assert.deepEqual(json('SELECT jsonb_agg(to_jsonb(p) ORDER BY draft_year,round,tier) FROM public.dynasty_pick_values p'), picksBefore)
  console.log('PASS: three Hashtag views sync 400/400/52 rows through the restored worker; 450 trade rows and 27 pick bands stay intact')
  if (process.argv.includes('--sync-only')) return
  const password = `Local-${crypto.randomUUID()}`
  const email = `hashtag-${crypto.randomUUID()}@example.test`
  const created = await must(supabase.auth.admin.createUser({ email, password, email_confirm: true }))
  const userId = created.user.id
  const leagueId = crypto.randomUUID()
  const memberId = crypto.randomUUID()
  const seasonYear = Math.min(...picksBefore.map(row => row.draft_year)) - 1
  await must(supabase.from('leagues').insert({ id: leagueId, name: 'Hashtag regression', slug: leagueId,
    commissioner_id: userId, status: 'active' }))
  await must(supabase.from('league_seasons').insert({ league_id: leagueId, season_year: seasonYear, is_current: true }))
  await must(supabase.from('league_members').insert({ id: memberId, league_id: leagueId, user_id: userId,
    role: 'commissioner', team_name: 'Hashtag team' }))
  const supabaseModule = 'npm:@supabase/supabase-js@2.98.0'
  const { createClient } = await import(supabaseModule)
  const member = createClient(status.API_URL, status.PUBLISHABLE_KEY ?? status.ANON_KEY, { auth: { persistSession: false } })
  const session = await must(member.auth.signInWithPassword({ email, password }))
  const player = players.find(row => row.display_name === 'Cooper Flagg')
  assert.ok(player)
  const { handleViewRoute } = await import('../../supabase/functions/api/views/' + 'index.ts')
  for (const section of ['overview', undefined]) {
    const url = new URL(`${status.API_URL}/functions/v1/api/views/player`)
    url.searchParams.set('leagueId', leagueId)
    url.searchParams.set('memberId', memberId)
    url.searchParams.set('params', JSON.stringify({ playerId: player.id, section }))
    const response = await handleViewRoute(new Request(url, { headers: { authorization: `Bearer ${session.session.access_token}` } }), '/views/player')
    assert.equal(response.status, 200)
    const { view } = await response.json()
    assert.equal(view.player.five_year_points, 10)
    assert.equal(view.player.three_year_points, 12)
    assert.equal(view.player.dynasty_rank, 21)
    assert.equal(view.player.dynasty_rank_source, 'hashtagbasketball.com')
    assert.equal(view.player.trade_value, undefined)
  }
  const inputs = await must(member.rpc('get_dynasty_forecast_inputs', { p_league_id: leagueId, p_member_id: memberId,
    p_season_year: seasonYear, p_player_ids: [player.id] }))
  assert.equal(inputs[0].ranking_source, 'hashtagbasketball.com')
  assert.equal(inputs[0].five_year_rank, 21)
  assert.equal(inputs[0].three_year_rank, 11)
  const ranksBeforePublish = json('SELECT jsonb_agg(jsonb_build_array(id,dynasty_rank,dynasty_rank_source,dynasty_rank_fetched_at) ORDER BY id) FROM public.players')
  await publish()
  assert.deepEqual(json('SELECT jsonb_agg(jsonb_build_array(id,dynasty_rank,dynasty_rank_source,dynasty_rank_fetched_at) ORDER BY id) FROM public.players'), ranksBeforePublish)
  const picks = await must(member.rpc('get_dynasty_pick_values', { p_league_id: leagueId }))
  assert.ok(picks.every(row => row.source === 'onenumberhoops.com'))
  assert.ok(picks.every(row => row.draft_year !== seasonYear))
  assert.ok(picks.some(row => row.draft_year === 2027 && row.trade_value > 0))
  console.log('PASS: authenticated player view returns both Hashtag point forecasts; trade publication preserves Hashtag screen ranks')
  if (process.env.HASHTAG_KEEP_FIXTURE === '1') {
    writeFileSync('../hashtag-browser-state.json', JSON.stringify({ email, password, leagueId, memberId, playerId: player.id, seasonYear }))
  } else {
    await must(supabase.from('leagues').delete().eq('id', leagueId))
    await must(supabase.auth.admin.deleteUser(userId))
  }
}

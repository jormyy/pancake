import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { chromium, webkit } from 'playwright'
import { pathToFileURL } from 'node:url'

export async function verifyPlayersEmptyRecovery() {
  const fixture = JSON.parse(await readFile(process.env.PLAYER_SEARCH_FIXTURE, 'utf8'))
  const stack = JSON.parse(await readFile(process.env.PLAYER_SEARCH_STACK, 'utf8'))
  assert.match(stack.API_URL, /^http:\/\/127\.0\.0\.1:/)
  const admin = createClient(stack.API_URL, stack.SECRET_KEY, { auth: { persistSession: false } })
  const base = process.env.PLAYER_SEARCH_URL
  const reports = []
  const check = result => { if (result.error) throw result.error; return result.data }
  const season = check(await admin.from('league_seasons').select('id').eq('league_id', fixture.league.id).eq('is_current', true).single())
  const member = check(await admin.from('league_members').select('id').eq('league_id', fixture.league.id).eq('user_id', fixture.session.user.id).single())

  async function open(engine) {
    const browser = await engine.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
    await context.addInitScript(({ session }) => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), fixture)
    const page = await context.newPage()
    return { browser, page }
  }

  async function cachedEmpty(engine, name) {
    const { browser, page } = await open(engine)
    try {
      let first = true
      let release = () => {}
      const pending = new Promise(resolve => { release = () => resolve(undefined) })
      await page.route('**/rest/v1/rpc/search_players', async route => {
        const query = route.request().postDataJSON().p_query
        if (!query && first) { first = false; await route.fulfill({ json: [] }); return }
        if (!query) await pending
        await route.continue()
      })
      await page.goto(`${base}/players`)
      await page.getByText('No free agents right now.', { exact: true }).waitFor()
      const search = page.getByRole('textbox', { name: 'Search players', exact: true })
      await search.fill('NoMatchingPlayer')
      await page.getByText('No players match "NoMatchingPlayer".', { exact: true }).waitFor()
      const revalidation = page.waitForRequest(request => request.url().endsWith('/rpc/search_players') && request.postDataJSON().p_query === '')
      await search.fill('')
      await revalidation
      await page.getByText('Loading players…', { exact: true }).waitFor()
      assert.equal(await page.getByText('No free agents right now.', { exact: true }).count(), 0)
      release()
      await page.getByRole('button', { name: `Open ${fixture.player.display_name}`, exact: true }).waitFor()
      reports.push({ engine: name, case: 'cached empty revalidation', passed: true })
    } finally { await browser.close() }
  }

  async function supportFailure(engine, name) {
    const { browser, page } = await open(engine)
    try {
      let empty = true
      await page.route('**/rest/v1/rpc/search_players', route => empty ? route.fulfill({ json: [] }) : route.continue())
      await page.goto(`${base}/players`)
      await page.getByText('No free agents right now.', { exact: true }).waitFor()
      let broken = true
      await page.route('**/rest/v1/roster_players?**', route => broken ? route.fulfill({ status: 503, json: { message: 'Roster unavailable' } }) : route.continue())
      await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')) })
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
      assert.equal(await page.getByText('No free agents right now.', { exact: true }).count(), 0)
      broken = false
      empty = false
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await page.getByRole('button', { name: `Open ${fixture.player.display_name}`, exact: true }).waitFor()
      reports.push({ engine: name, case: 'support failure and retry', passed: true })
    } finally { await browser.close() }
  }

  async function rosterChange(engine, name) {
    const roster = check(await admin.from('roster_players').insert({ league_id: fixture.league.id, league_season_id: season.id, member_id: member.id, player_id: fixture.player.id, acquired_via: 'free_agent' }).select('id').single())
    const { browser, page } = await open(engine)
    try {
      await page.goto(`${base}/players`)
      await page.getByText('No free agents right now.', { exact: true }).waitFor()
      let release = () => {}
      const pending = new Promise(resolve => { release = () => resolve(undefined) })
      await page.route('**/rest/v1/roster_players?**', async route => { await pending; await route.continue() })
      check(await admin.from('roster_players').delete().eq('id', roster.id))
      await page.getByText('Loading players…', { exact: true }).waitFor()
      assert.equal(await page.getByText('No free agents right now.', { exact: true }).count(), 0)
      release()
      await page.getByRole('button', { name: `Open ${fixture.player.display_name}`, exact: true }).waitFor()
      await page.screenshot({ path: `${process.env.PLAYER_SEARCH_ARTIFACT_DIR}/${name}-free-agents.png` })
      reports.push({ engine: name, case: 'empty pool becomes available', passed: true })
    } finally {
      await browser.close()
      check(await admin.from('roster_players').delete().eq('id', roster.id))
    }
  }

  async function pagination(engine, name) {
    const occupied = Array.from({ length: 20 }, (_, index) => ({ first_name: 'Owned', last_name: `Page${index}`, nba_team: 'BOS', position: 'PG', eligible_positions: ['PG'], status: 'Active' }))
    const available = Array.from({ length: 20 }, (_, index) => ({ first_name: 'Free', last_name: `Page${index}`, nba_team: 'BOS', position: 'PG', eligible_positions: ['PG'], status: 'Active' }))
    const players = check(await admin.from('players').insert([...occupied, ...available]).select('id,display_name'))
    const ownedIds = players.slice(0, 20).map(player => player.id)
    const freeIds = new Set([fixture.player.id, ...players.slice(20).map(player => player.id)])
    const stat = check(await admin.from('player_game_stats').select('game_id,season_year,week_number').eq('player_id', fixture.player.id).single())
    const { browser, page } = await open(engine)
    try {
      check(await admin.from('roster_players').insert(ownedIds.map(player_id => ({ league_id: fixture.league.id, league_season_id: season.id, member_id: member.id, player_id, acquired_via: 'free_agent' }))))
      check(await admin.from('player_game_stats').insert(ownedIds.map(player_id => ({ ...stat, player_id, points: 100, minutes_played: 30 }))))
      const firstPage = page.waitForResponse(response => response.url().endsWith('/rpc/search_players') && response.request().postDataJSON().p_offset === 0)
      await page.goto(`${base}/players`)
      const first = await firstPage
      assert.equal(first.request().postDataJSON().p_exclude_player_ids.length, 20)
      const firstRows = await first.json()
      assert.equal(firstRows.length, 20)
      assert.ok(firstRows.every(player => freeIds.has(player.id)))
      await page.getByRole('button', { name: `Open ${fixture.player.display_name}`, exact: true }).waitFor()
      const secondPage = page.waitForResponse(response => response.url().endsWith('/rpc/search_players') && response.request().postDataJSON().p_offset === 20)
      await page.evaluate(() => {
        for (const element of document.querySelectorAll('*')) {
          if (element.scrollHeight > element.clientHeight + 20) element.scrollTop = element.scrollHeight
        }
      })
      const secondRows = await (await secondPage).json()
      assert.equal(secondRows.length, 1)
      assert.ok(freeIds.has(secondRows[0].id))
      reports.push({ engine: name, case: 'server exclusions and second page', passed: true, firstPage: 20, secondPage: 1 })
    } finally {
      await browser.close()
      check(await admin.from('roster_players').delete().in('player_id', ownedIds))
      check(await admin.from('player_game_stats').delete().in('player_id', ownedIds))
      check(await admin.from('players').delete().in('id', players.map(player => player.id)))
    }
  }

  try {
    for (const [name, engine] of Object.entries({ chromium, webkit })) {
      await cachedEmpty(engine, name)
      await supportFailure(engine, name)
      await rosterChange(engine, name)
      await pagination(engine, name)
    }
  } finally {
    await writeFile(`${process.env.PLAYER_SEARCH_ARTIFACT_DIR}/players-empty-report.json`, JSON.stringify(reports, null, 2))
    console.log(JSON.stringify(reports))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyPlayersEmptyRecovery()

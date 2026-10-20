import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setupTradeGameplayFixture } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { openWebTarget, pressWebControl, pinWebTargetLeague, navigateWebTarget, reloadWebTarget, waitForWebTargetReady, waitForWebAuthForm, waitForWebTargetReads, waitForWebTargetGeometry } from './web-targets-browser.mjs'
import { ensureSyntheticSeasonWeeks } from './soak-fixtures.mjs'
import { summarizeWebTargetGeometry } from './web-targets-geometry.mjs'

export const checkWebEmptySlots = (target, captures, env) => runWithScenarioResourceOwner('web empty slots', async (resourceOwner) => {
  const fixture = await setupTradeGameplayFixture(env, 0, { includeFuturePicks: false, isolatedPlayers: true })
  await ensureSyntheticSeasonWeeks(fixture.admin, fixture.currentSeason.season_year, 26, 'web empty slots', resourceOwner)
  const weeks = await fixture.admin.from('season_weeks').select('week_number,week_start,week_end')
    .eq('season_year', fixture.currentSeason.season_year).order('week_number')
  if (weeks.error) throw weeks.error
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const week = weeks.data.find((row) => row.week_end >= today) ?? weeks.data.at(-1)
  assert.ok(week, 'Empty-slot fixture needs a current or next calendar week')
  const { browser, context, page } = await openWebTarget(target, captures)
  const pinLeague = () => pinWebTargetLeague(target, page, {
    userId: fixture.users[0].id, memberId: fixture.proposer.id, leagueName: fixture.league.name,
  })
  const checked = []
  const apply = async (active, bench, ir, taxi) => {
    for (const operation of [
      () => fixture.admin.from('roster_players').delete().eq('league_id', fixture.league.id),
      () => fixture.admin.from('leagues').update({ roster_size: active, ir_slots: ir, taxi_slots: taxi }).eq('id', fixture.league.id),
      () => fixture.admin.from('lineup_slot_templates').delete().eq('league_id', fixture.league.id),
      () => active > 0 || bench > 0 ? fixture.admin.from('lineup_slot_templates').insert([
        { league_id: fixture.league.id, slot_type: 'PG', slot_count: active - bench },
        { league_id: fixture.league.id, slot_type: 'BE', slot_count: bench },
      ].filter((row) => row.slot_count > 0)) : { error: null },
    ]) {
      const result = await operation()
      if (result.error) throw result.error
    }
  }
  const visit = async (route) => {
    await navigateWebTarget(page, new URL(route, env.frontendUrl).href)
    await waitForWebTargetReady(page)
    await pinLeague()
    if (new URL(page.url()).pathname === '/roster') await page.getByText('Your roster is empty', { exact: true }).waitFor()
    if (new URL(page.url()).pathname === '/team-roster') await page.getByText('No players yet', { exact: true }).waitFor()
    if (new URL(page.url()).pathname === '/lineup') {
      await page.waitForFunction(() => {
        const toggle = document.querySelector('input[aria-label="Auto-set daily"]')
        return toggle instanceof HTMLInputElement && !toggle.disabled
      })
    }
  }
  // The roster splits active capacity into lineup slots; the team view lists it as one block.
  const countActive = async (route) => {
    if (route === '/roster') {
      await count('Empty PG slot', 1)
      await count('Empty bench slot', 3)
    } else await count('Empty roster slot', 4)
  }
  const count = async (text, expected) => {
    const rows = page.getByText(text, { exact: true })
    let actual = await rows.count()
    for (let attempt = 0; actual !== expected && attempt < 120; attempt += 1) {
      await page.waitForTimeout(250)
      actual = await rows.count()
    }
    assert.equal(actual, expected, `${page.url()}: every ${text} needs an individual row`)
    checked.push({ route: new URL(page.url()).pathname, label: text, expected, actual })
  }
  try {
    const matchup = await fixture.admin.from('matchups').insert({
      league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, week_number: week.week_number,
      home_member_id: fixture.proposer.id, away_member_id: fixture.recipient.id,
    })
    if (matchup.error) throw matchup.error
    await apply(4, 3, 2, 2)
    await navigateWebTarget(page, new URL('/sign-in', env.frontendUrl).href)
    await page.waitForFunction(() => performance.getEntriesByName('pancake-app-mounted').length > 0)
    await waitForWebAuthForm(page, 'you@example.com')
    await page.getByPlaceholder('you@example.com').fill(fixture.users[0].email)
    await page.locator('input[type="password"]').fill(fixture.password)
    await pressWebControl(target, page.getByRole('button', { name: 'Sign In', exact: true }))
    await page.waitForURL((url) => url.pathname === '/')
    await pinLeague()
    await page.getByRole('button', { name: 'Select empty BE slot 1', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^Select empty BE slot/ }).count(), 3)
    assert.equal(await page.getByRole('button', { name: /^Select empty IR slot/ }).count(), 2)
    assert.equal(await page.getByRole('button', { name: /^Select empty TX slot/ }).count(), 2)
    checked.push({ route: '/', label: 'BE / IR / taxi', expected: [3, 2, 2], actual: [3, 2, 2] })
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    await reloadWebTarget(page)
    await pinLeague()
    await page.getByRole('button', { name: 'Select empty BE slot 1', exact: true }).waitFor()
    const frames = await waitForWebTargetGeometry(page, {
      mobile: target.mobile, populatedSelector: '[aria-label="Select empty BE slot 1"]', requireFirstContent: true,
    }).finally(async () => {
      await writeFile(path.join(captures, 'slots-home-frames.json'), `${JSON.stringify(await page.evaluate(() => Reflect.get(window, '__webTargetFrames')))}\n`)
    })
    const first = frames.filter((frame) => frame.phase === 'app' && frame.first).map((frame) => frame.first)
    assert.ok(first.length > 1, 'Populated Home must expose its first content geometry')
    const minimum = Math.min(...first.map((box) => box.y))
    const maximum = Math.max(...first.map((box) => box.y))
    assert.ok(maximum - minimum <= 2, `First Home content moves ${maximum - minimum}px during data load`)
    checked.push({ route: '/', label: 'first-content-after-data', samples: first.length, minY: minimum, maxY: maximum, recorder: summarizeWebTargetGeometry(frames) })
    await page.screenshot({ path: path.join(captures, 'slots-home.png'), fullPage: true })
    const homeCacheKey = `pancake:home-matchup:v1:${fixture.league.id}:${fixture.proposer.id}`
    await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), homeCacheKey)
    await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key))
      if (saved.value.myLineup.benchSlots !== 3) throw new Error('Legacy cache fixture must begin with three known bench places')
      delete saved.value.myLineup.benchSlots
      delete saved.value.oppLineup.benchSlots
      localStorage.setItem(key, JSON.stringify(saved))
    }, homeCacheKey)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    try {
      await waitForWebTargetReads(page)
      await context.setOffline(true)
      await reloadWebTarget(page)
      await page.getByText("Couldn't load your matchup", { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: /^Select empty BE slot/ }).count(), 0)
      await page.screenshot({ path: path.join(captures, 'slots-home-legacy-offline.png'), fullPage: true })
    } finally { await context.setOffline(false) }
    await page.getByRole('button', { name: 'Select empty BE slot 1', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^Select empty BE slot/ }).count(), 3)
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).value.myLineup.benchSlots === 3, homeCacheKey)
    checked.push({ route: '/', label: 'legacy-cache-capacity-recovery', offline: 'unknown capacity is not displayed as zero', restored: 3 })
    for (const [name, route] of [['roster', '/roster'], ['team', `/team-roster?memberId=${fixture.recipient.id}`]]) {
      await visit(route)
      await page.getByText('Empty IR slot', { exact: true }).first().waitFor()
      await countActive(route)
      await count('Empty IR slot', 2)
      await count('Empty taxi slot', 2)
      await page.screenshot({ path: path.join(captures, `slots-${name}.png`), fullPage: true })
    }
    await visit('/lineup')
    await page.getByRole('button', { name: 'Empty PG slot', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Empty bench slot', exact: true }).count(), 3)
    await page.screenshot({ path: path.join(captures, 'slots-lineup.png'), fullPage: true })
    const dates = page.locator('[aria-current="date"]')
    const day = await dates.getAttribute('aria-label')
    const next = page.locator('[role="button"][aria-label]:not([aria-current="date"])')
      .filter({ hasText: /^[MTWRFS]\s*\d+$/ }).first()
    assert.ok(await next.count(), 'Lineup must expose another day')
    await pressWebControl(target, next)
    await page.waitForTimeout(400)
    assert.equal(await page.getByRole('button', { name: 'Empty bench slot', exact: true }).count(), 3)
    assert.notEqual(await dates.getAttribute('aria-label'), day)
    checked.push({ route: '/lineup', label: 'day-change', previous: day, next: await dates.getAttribute('aria-label') })
    const offseason = await fixture.admin.from('leagues').update({ status: 'offseason' }).eq('id', fixture.league.id)
    if (offseason.error) throw offseason.error
    for (const route of ['/roster', `/team-roster?memberId=${fixture.recipient.id}`]) {
      await visit(route)
      await countActive(route)
      await count('Empty IR slot', 2)
      await count('Empty taxi slot', 2)
    }
    await visit('/lineup')
    await page.getByRole('button', { name: 'Empty PG slot', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Empty bench slot', exact: true }).count(), 3)
    await visit('/')
    await page.getByRole('button', { name: 'Select empty BE slot 1', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^Select empty BE slot/ }).count(), 3)
    assert.equal(await page.getByRole('button', { name: /^Select empty IR slot/ }).count(), 2)
    assert.equal(await page.getByRole('button', { name: /^Select empty TX slot/ }).count(), 2)
    checked.push({ route: 'all four surfaces', label: 'offseason capacities', expected: [4, 3, 2, 2], actual: [4, 3, 2, 2] })
    await apply(0, 0, 0, 0)
    for (const route of ['/roster', `/team-roster?memberId=${fixture.recipient.id}`, '/lineup']) {
      await visit(route)
      for (const label of ['Empty roster slot', 'Empty PG slot', 'Empty IR slot', 'Empty taxi slot', 'Empty bench slot']) await count(label, 0)
    }
    await visit('/')
    await page.getByRole('heading', { name: /^Weeks? .* matchup$/ }).waitFor()
    const emptyHome = page.getByRole('button', { name: /^Select empty (BE|IR|TX|PG) slot/ })
    for (let attempt = 0; await emptyHome.count() > 0 && attempt < 120; attempt += 1) await page.waitForTimeout(250)
    assert.equal(await emptyHome.count(), 0, 'Zero-capacity Home must hide empty slot sections')
    checked.push({ route: '/', label: 'zero-capacity-empty-slots', expected: 0, actual: 0 })
    return checked
  } catch (error) {
    await page.screenshot({ path: path.join(captures, 'slots-failure.png') }).catch(() => {})
    await writeFile(path.join(captures, 'slots-failure.txt'), await page.locator('body').innerText())
    await writeFile(path.join(captures, 'slots-error.json'), JSON.stringify({
      error: error instanceof Error ? error.stack : String(error),
      state: await page.evaluate((key) => ({
        cache: JSON.parse(localStorage.getItem(key) ?? 'null')?.value?.myLineup?.benchSlots,
        worker: Boolean(navigator.serviceWorker.controller), visibility: document.visibilityState,
      }), `pancake:home-matchup:v1:${fixture.league.id}:${fixture.proposer.id}`).catch(() => null),
    }, null, 2))
    throw error
  } finally {
    await context.close()
    await browser.close()
    await fixture.dispose()
  }
})

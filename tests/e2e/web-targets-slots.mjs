import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setupTradeGameplayFixture } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { openWebTarget, pressWebControl } from './web-targets-browser.mjs'

export const checkWebEmptySlots = (target, captures, env) => runWithScenarioResourceOwner('web empty slots', async () => {
  const fixture = await setupTradeGameplayFixture(env, 0, { includeFuturePicks: false, isolatedPlayers: true })
  const { browser, context, page } = await openWebTarget(target, captures)
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
    await page.goto(new URL(route, env.frontendUrl).href)
    await page.locator('[role="navigation"][aria-label="Primary"]').waitFor()
    if (new URL(page.url()).pathname === '/roster') await page.getByText('Your roster is empty', { exact: true }).waitFor()
    if (new URL(page.url()).pathname === '/team-roster') await page.getByText('No players yet', { exact: true }).waitFor()
    if (new URL(page.url()).pathname === '/lineup') {
      await page.waitForFunction(() => {
        const toggle = document.querySelector('input[aria-label="Auto-set daily"]')
        return toggle instanceof HTMLInputElement && !toggle.disabled
      })
    }
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
      league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, week_number: 1,
      home_member_id: fixture.proposer.id, away_member_id: fixture.recipient.id,
    })
    if (matchup.error) throw matchup.error
    await apply(4, 3, 2, 2)
    await page.goto(new URL('/sign-in', env.frontendUrl).href)
    await page.waitForFunction(() => performance.getEntriesByName('pancake-app-mounted').length > 0)
    await page.getByPlaceholder('you@example.com').fill(fixture.users[0].email)
    await page.locator('input[type="password"]').fill(fixture.password)
    await pressWebControl(target, page.getByRole('button', { name: 'Sign In', exact: true }))
    await page.waitForURL((url) => url.pathname === '/')
    await page.getByRole('button', { name: 'Select empty BE slot 1', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^Select empty BE slot/ }).count(), 3)
    assert.equal(await page.getByRole('button', { name: /^Select empty IR slot/ }).count(), 2)
    assert.equal(await page.getByRole('button', { name: /^Select empty TX slot/ }).count(), 2)
    checked.push({ route: '/', label: 'BE / IR / taxi', expected: [3, 2, 2], actual: [3, 2, 2] })
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Select empty BE slot 1', exact: true }).waitFor()
    await page.waitForTimeout(500)
    const frames = await page.evaluate(() => Reflect.get(window, '__webTargetFrames'))
    await writeFile(path.join(captures, 'slots-home-frames.json'), `${JSON.stringify(frames)}\n`)
    const first = frames.filter((frame) => frame.phase === 'app' && frame.first).map((frame) => frame.first)
    assert.ok(first.length > 1, 'Populated Home must expose its first content geometry')
    const minimum = Math.min(...first.map((box) => box.y))
    const maximum = Math.max(...first.map((box) => box.y))
    assert.ok(maximum - minimum <= 2, `First Home content moves ${maximum - minimum}px during data load`)
    checked.push({ route: '/', label: 'first-content-after-data', samples: first.length, minY: minimum, maxY: maximum })
    await page.screenshot({ path: path.join(captures, 'slots-home.png'), fullPage: true })
    for (const [name, route] of [['roster', '/roster'], ['team', `/team-roster?memberId=${fixture.recipient.id}`]]) {
      await visit(route)
      await page.getByText('Empty roster slot', { exact: true }).first().waitFor()
      await count('Empty roster slot', 4)
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
    await apply(0, 0, 0, 0)
    for (const route of ['/roster', `/team-roster?memberId=${fixture.recipient.id}`, '/lineup']) {
      await visit(route)
      for (const label of ['Empty roster slot', 'Empty IR slot', 'Empty taxi slot', 'Empty bench slot']) await count(label, 0)
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
    throw error
  } finally {
    await context.close()
    await browser.close()
    await fixture.dispose()
  }
})

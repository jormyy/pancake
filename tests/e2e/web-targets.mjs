import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { WEB_TARGETS, openWebTarget, readWebLayout, pressWebControl } from './web-targets-browser.mjs'
import { runWebTargetUpdates } from './web-targets-update.mjs'
import { checkWebEmptySlots } from './web-targets-slots.mjs'
import { ensureSweepDrafts } from './browser-smoke.mjs'

const root = process.cwd()
const frontend = process.env.E2E_FRONTEND_URL ?? 'http://127.0.0.1:8082'
const artifactDir = path.resolve(process.env.E2E_WEB_TARGET_ARTIFACT_DIR ?? 'tests/artifacts/web-targets')
const reportPath = path.resolve(process.env.E2E_WEB_TARGET_REPORT_PATH ?? 'tests/e2e-browser-web-targets-report.json')
const url = (route) => new URL(route, frontend).href
const errorText = (error) => error instanceof Error ? error.message : String(error)

async function metadata(page) {
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href')
  const response = await page.request.get(url(manifestUrl))
  assert.equal(response.status(), 200)
  const manifest = await response.json()
  assert.ok(manifest.name && manifest.short_name)
  assert.equal(manifest.display, 'standalone')
  assert.equal(new URL(manifest.start_url, frontend).origin, new URL(frontend).origin)
  assert.equal(manifest.scope, '/')
  assert.ok(manifest.theme_color && manifest.background_color)
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'))
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'))
  for (const icon of manifest.icons) {
    const asset = await page.request.get(url(icon.src))
    assert.equal(asset.status(), 200, icon.src)
    assert.ok(asset.headers()['content-type'].startsWith('image/'), icon.src)
    assert.ok((await asset.body()).length > 100, icon.src)
  }
  assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'), 'yes')
  assert.ok(await page.locator('meta[name="apple-mobile-web-app-status-bar-style"]').getAttribute('content'))
  assert.ok(await page.locator('meta[name="theme-color"]').getAttribute('content'))
  assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'), /viewport-fit=cover/)
  const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  assert.equal((await page.request.get(url(appleIcon))).status(), 200)
  return { manifest, appleIcon }
}

async function ready(page) {
  await page.locator('[role="navigation"][aria-label="Primary"]').waitFor({ timeout: 45_000 })
  await page.locator('[role="main"]').waitFor({ timeout: 45_000 })
  await page.waitForFunction(() => document.querySelector('[role="main"]')?.textContent.trim().length > 5)
  await page.waitForTimeout(400)
}

async function home(page, client) {
  const primary = page.getByRole('navigation', { name: 'Primary', exact: true })
  const target = primary.getByRole('link', { name: /^(Matchup|Home)$/ }).first()
  if (await target.count()) await pressWebControl(client, target)
  else await pressWebControl(client, primary.getByRole('button', { name: /^(Matchup|Home)$/ }).first())
  await page.waitForURL((value) => value.pathname === '/')
  await ready(page)
}

async function checkInputs(page) {
  const inputs = page.locator('input:not([type="file"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]),textarea')
  const inspected = []
  for (const input of await inputs.all()) {
    if (!await input.isVisible()) continue
    const detail = await input.evaluate((node) => ({
      label: node.getAttribute('aria-label') ?? node.getAttribute('placeholder'),
      font: parseFloat(getComputedStyle(node).fontSize),
    }))
    assert.ok(detail.font >= 16, `${detail.label}: ${detail.font}px input can cause iPhone focus zoom`)
    await input.focus()
    await input.scrollIntoViewIfNeeded()
    assert.equal(await input.evaluate((node) => document.activeElement === node), true)
    const box = await input.boundingBox()
    const primary = page.getByRole('navigation', { name: 'Primary', exact: true })
    const nav = await primary.count() ? await primary.boundingBox() : null
    const bottom = nav && nav.width > page.viewportSize().width * 0.8 && nav.y > 0 ? nav.y : page.viewportSize().height
    assert.ok(box && box.x >= -1 && box.x + box.width <= page.viewportSize().width + 1, `${detail.label}: clipped input`)
    assert.ok(box.y >= 0 && box.y + box.height <= bottom + 1, `${detail.label}: input cannot scroll above fixed navigation`)
    inspected.push(detail)
  }
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  return inspected
}

async function launch(page, mobile, captures) {
  await page.reload({ waitUntil: 'load' })
  await ready(page)
  await page.waitForFunction(() => {
    const main = document.querySelector('[role="main"]')
    return main?.querySelector('[role="heading"][aria-label$=" matchup"]') ||
      /No matchup this week yet|Your draft is live/.test(main?.textContent ?? '')
  })
  await page.waitForTimeout(500)
  const frames = await page.evaluate(() => Reflect.get(window, '__webTargetFrames'))
  await writeFile(path.join(captures, 'launch-frames.json'), `${JSON.stringify(frames)}\n`)
  const shell = frames.filter((frame) => frame.phase === 'shell')
  const app = frames.filter((frame) => frame.phase === 'app')
  assert.ok(shell.length, 'Signed-in relaunch must paint the static shell')
  assert.ok(app.length, 'Static shell must hand off to the app')
  assert.equal(frames.some((frame) => frame.duplicate), false, 'Two sets of chrome appear together')
  const before = shell.at(-1)
  const after = app.at(-1)
  const changes = []
  for (const part of mobile ? ['top', 'nav', 'content'] : ['nav', 'content']) {
    assert.ok(before[part] && after[part], `Missing ${part} geometry`)
    for (const dimension of ['x', 'y', 'width', 'height']) {
      const delta = Math.abs(before[part][dimension] - after[part][dimension])
      changes.push({ part, dimension, delta })
      assert.ok(delta <= 2, `${part}.${dimension} moves ${delta}px at handoff`)
    }
  }
  const headings = app.filter((frame) => frame.first).map((frame) => frame.first)
  if (headings.length > 1) {
    const y = headings.map((box) => box.y)
    assert.ok(Math.max(...y) - Math.min(...y) <= 2, 'First content jumps during data load')
  }
  return { before, after, shellFrames: shell.length, appFrames: app.length, changes,
    firstContent: { samples: headings.length, minY: Math.min(...headings.map((box) => box.y)), maxY: Math.max(...headings.map((box) => box.y)) } }
}

async function offline(page, context) {
  await page.goto(url('/lineup'))
  await ready(page)
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 30_000 })
  const slots = page.getByRole('button', { name: /^(?:Empty .+ slot|Bench .+|(?:PG|SG|SF|PF|C|G|F|UTIL) .+)$/ })
  const before = await slots.count()
  assert.ok(before > 0, 'Seed must expose configured lineup places')
  const selected = await page.locator('[aria-current="date"]').getAttribute('aria-label')
  await context.setOffline(true)
  try {
    await page.reload({ waitUntil: 'load' })
    await ready(page)
    await page.getByText('Saved lineup · Offline · Read only', { exact: true }).waitFor()
    assert.equal(await slots.count(), before, 'Offline reload loses saved lineup places')
    assert.equal(await page.locator('[aria-current="date"]').getAttribute('aria-label'), selected)
    assert.ok(await page.getByText(/Offline · League access/).isVisible())
    for (const slot of await slots.all()) assert.equal(await slot.getAttribute('aria-disabled'), 'true')
    const auto = page.getByRole('button', { name: 'Open auto-set lineup options', exact: true })
    if (await auto.count()) assert.equal(await auto.isDisabled(), true)
    return { savedRows: before, disabledRows: await slots.count(), offlineLaunch: true }
  } finally {
    await context.setOffline(false)
    await page.waitForFunction(() => !document.body.textContent.includes('Saved lineup · Offline · Read only'))
  }
}

export async function runWebTargets({ season = 0 } = {}) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(frontend).hostname), 'Web matrix requires a local stack')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.E2E_SUPABASE_URL).hostname), 'Web fixtures require local Supabase')
  await mkdir(artifactDir, { recursive: true })
  const state = JSON.parse(await readFile(path.join(root, 'tests/e2e-state.json'), 'utf8'))
  const admin = createClient(process.env.E2E_SUPABASE_URL, process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } })
  const members = await admin.from('league_members').select('id,user_id,team_name').eq('league_id', state.leagueId)
  if (members.error) throw members.error
  const me = members.data.find((member) => member.user_id === state.users[0].id)
  const other = members.data.find((member) => member.user_id !== state.users[0].id)
  const players = await admin.from('players').select('id').like('sportsdata_id', 'e2e-player-%').limit(1)
  if (players.error || !players.data.length) throw new Error('Run e2e:seed before the web matrix')
  const { auctionDraft, rookieDraft } = await ensureSweepDrafts(admin, state, members.data)
  const auction = auctionDraft.id
  const rookie = rookieDraft.id
  const routes = [
    ['home', '/'], ['roster', '/roster'], ['players', '/players'], ['trades', '/trades'],
    ['league', '/league'], ['dynasty', '/dynasty'], ['rankings', '/players?section=rankings'],
    ['news', '/players?section=news'], ['profile', '/profile'], ['create-league', '/create-league'],
    ['join-league', '/join-league'], ['settings', '/commissioner-settings'], ['password', '/change-password'],
    ['lineup', '/lineup'], ['bracket', '/bracket'], ['claim', `/claim-player?playerId=${players.data[0].id}`],
    ['player', `/player/${players.data[0].id}`], ['trade', `/propose-trade?recipientMemberId=${other.id}`],
    ['team', `/team-roster?memberId=${other.id}`], ['auction', `/draft-room?draftId=${auction}`],
    ['rookie', `/rookie-draft-room?draftId=${rookie}`], ['draft', '/draft'], ['not-found', '/web-target-missing'],
    ['auction-missing', '/draft-room?draftId=00000000-0000-0000-0000-000000000000'],
    ['rookie-missing', '/rookie-draft-room?draftId=00000000-0000-0000-0000-000000000000'],
  ]
  const release = await fetch(url('/release-provenance.json')).then((response) => response.json())
  const harnessHash = createHash('sha256')
  for (const file of ['web-targets.mjs', 'web-targets-browser.mjs', 'web-targets-slots.mjs', 'web-targets-update.mjs', 'browser-smoke.mjs']) {
    harnessHash.update(await readFile(new URL(file, import.meta.url)))
  }
  const harness = { commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), digest: harnessHash.digest('hex'),
    dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0 }
  const report = { status: 'FAIL', season, artifactDir, harness, release: { commitSha: release.commitSha, bundleDigest: release.bundleDigest }, generatedAt: new Date().toISOString(),
    simulation: 'Playwright WebKit iPhone descriptors; navigator.standalone and display-mode matchMedia are injected. CSS env() values are replaced with test insets. No Home Screen installation, real keyboard, status bar, home indicator, or background suspension is tested.',
    targets: [], updates: null }
  const selectedTargets = WEB_TARGETS.filter((target) => !process.env.E2E_WEB_TARGET_FILTER || target.id.includes(process.env.E2E_WEB_TARGET_FILTER))
  assert.ok(selectedTargets.length, 'Target filter must match a supported target')
  for (const target of selectedTargets) {
    const captures = path.join(artifactDir, target.id)
    await mkdir(captures, { recursive: true })
    const { browser, context, page } = await openWebTarget(target, captures)
    const result = { id: target.id, target, checks: [], errors: [] }
    let phase = 'session'
    report.targets.push(result)
    page.on('pageerror', (error) => result.errors.push({ phase, message: errorText(error), stack: error.stack }))
    const check = async (name, action) => {
      phase = name
      try {
        result.checks.push({ name, status: 'PASS', detail: await action() })
      } catch (error) {
        result.checks.push({ name, status: 'FAIL', error: errorText(error) })
        await page.screenshot({ path: path.join(captures, `${name.replace(/[^a-z0-9-]/gi, '-')}-failure.png`) }).catch(() => {})
      }
      process.stdout.write(`${target.id} ${name}: ${result.checks.at(-1).status} ${result.checks.at(-1).error ?? ''}\n`)
      await writeFile(path.join(captures, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    }
    try {
      await page.goto(url('/sign-up'))
      await page.waitForFunction(() => performance.getEntriesByName('pancake-app-mounted').length > 0)
      await page.getByPlaceholder('Maple Manager').waitFor()
      await check('sign-up-inputs', () => checkInputs(page))
      await page.goto(url('/sign-in'))
      await page.waitForFunction(() => performance.getEntriesByName('pancake-app-mounted').length > 0)
      await page.getByPlaceholder('you@example.com').waitFor()
      await check('install-metadata', () => metadata(page))
      await check('sign-in-inputs', () => checkInputs(page))
      await page.evaluate(() => {
        Reflect.set(window, '__webAuthSubmits', 0)
        const original = window.fetch.bind(window)
        window.fetch = async (input, init) => {
          if (String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes('/auth/v1/token')) {
            Reflect.set(window, '__webAuthSubmits', Reflect.get(window, '__webAuthSubmits') + 1)
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
          return original(input, init)
        }
      })
      await page.getByPlaceholder('you@example.com').fill(state.users[0].email)
      const password = page.locator('input[type="password"]')
      await password.fill(state.password)
      await password.press('Enter')
      await password.focus()
      await password.press('Enter')
      await page.waitForURL((value) => value.pathname === '/', { timeout: 45_000 })
      await ready(page)
      await check('return-submits-once', async () => {
        const submits = await page.evaluate(() => Reflect.get(window, '__webAuthSubmits'))
        assert.equal(submits, 1, `Return starts ${submits} auth requests`)
        return { submits }
      })
      await check('launch-handoff', () => launch(page, target.mobile, captures))
      await check('tab-navigation', async () => {
        const visited = []
        for (const [name, route] of [['Roster', '/roster'], ['Players', '/players'], ['Trades', '/trades'], ['League', '/league'], ['Matchup', '/']]) {
          const nav = page.getByRole('navigation', { name: 'Primary', exact: true })
          const link = nav.getByRole('link', { name: new RegExp(`^${name}(?:,|$)`) }).first()
          if (await link.count()) await pressWebControl(target, link)
          else await pressWebControl(target, nav.getByRole('button', { name, exact: true }))
          await page.waitForURL((value) => value.pathname === route)
          await ready(page)
          visited.push(route)
        }
        const pointer = await page.evaluate(() => Reflect.get(window, '__webTargetPointer'))
        assert.equal(pointer, target.mobile ? 'touch' : 'mouse')
        return { visited, pointer }
      })
      for (const [name, route] of routes) {
        await check(`route-${name}`, async () => {
          await page.goto(url(route))
          await ready(page)
          const layout = await readWebLayout(page, target.insets)
          assert.equal(layout.client.width, target.viewport.width)
          assert.equal(layout.client.height, target.viewport.height)
          assert.equal(layout.client.dpr, target.mobile ? 3 : 1)
          assert.equal(layout.client.coarse, target.mobile)
          assert.equal(/iPhone/.test(layout.client.userAgent), target.mobile)
          assert.equal(layout.overflow, 0, `${name}: horizontal overflow ${layout.overflow}px`)
          assert.equal(layout.standalone, target.standalone)
          assert.equal(layout.mediaStandalone, target.standalone)
          if (target.mobile) {
            assert.equal(layout.mainPadding.top, 56 + target.insets.top)
            assert.equal(layout.mainPadding.bottom, 64 + target.insets.bottom)
            assert.deepEqual(layout.duplicates, [], `${name}: content applies the shell safe area twice`)
          }
          layout.inputs = await checkInputs(page)
          await page.screenshot({ path: path.join(captures, `${name}.png`), fullPage: true })
          await home(page, target)
          return layout
        })
      }
      if (target.mobile) await check('sheet-safe-area-and-exit', async () => {
        await home(page, target)
        await pressWebControl(target, page.getByRole('button', { name: 'Open menu', exact: true }))
        const panel = page.locator('[id^="sheet-"][tabindex="-1"]')
        await panel.waitFor()
        const padding = await panel.evaluate((node) => parseFloat(getComputedStyle(node).paddingBottom))
        assert.ok(padding >= target.insets.bottom, 'The sheet must retain its home-indicator padding')
        await pressWebControl(target, page.getByRole('button', { name: 'Close', exact: true }))
        await panel.waitFor({ state: 'hidden' })
        return { bottomPadding: padding }
      })
      await check('profile-inputs-appearance-and-toast', async () => {
        await page.goto(url('/profile'))
        await ready(page)
        await pressWebControl(target, page.getByRole('button', { name: 'Edit', exact: true }))
        const inspected = await checkInputs(page)
        assert.equal(inspected.length, 2)
        if (target.mobile) {
          const viewport = page.viewportSize()
          try {
            await page.setViewportSize({ width: viewport.width, height: viewport.height - 300 })
            await checkInputs(page)
          } finally {
            await page.setViewportSize(viewport)
          }
        }
        await page.evaluate(() => {
          Reflect.set(window, '__webProfileSubmits', 0)
          const original = window.fetch.bind(window)
          window.fetch = async (input, init) => {
            const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
            if (url.includes('/rest/v1/profiles') && init?.method === 'PATCH') {
              Reflect.set(window, '__webProfileSubmits', Reflect.get(window, '__webProfileSubmits') + 1)
              await new Promise((resolve) => setTimeout(resolve, 500))
            }
            return original(input, init)
          }
        })
        const teamName = page.getByRole('textbox', { name: 'Team name', exact: true })
        await teamName.press('Enter')
        await teamName.focus()
        await teamName.press('Enter')
        const saved = page.getByText('Saved', { exact: true }).first()
        await saved.waitFor()
        assert.equal(await page.evaluate(() => Reflect.get(window, '__webProfileSubmits')), 1)
        const box = await saved.boundingBox()
        assert.ok(box.y >= target.insets.top, 'Toast must clear the top safe area')
        await pressWebControl(target, page.getByRole('button', { name: 'Dismiss', exact: true }))
        for (const [label, theme] of [['Dark', 'dark'], ['Match device', 'system'], ['Light', 'light']]) {
          await pressWebControl(target, page.getByRole('tab', { name: label, exact: true }))
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
          await page.reload({ waitUntil: 'load' })
          await ready(page)
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
        }
        return { inputs: inspected, toastY: box.y, themesPersist: true }
      })
      await check('empty-lineup-places', async () => {
        await page.goto(url('/lineup'))
        await ready(page)
        const templates = await admin.from('lineup_slot_templates').select('slot_type,slot_count').eq('league_id', state.leagueId)
        if (templates.error) throw templates.error
        const bench = templates.data.find((slot) => slot.slot_type === 'BE')?.slot_count ?? 0
        await page.waitForFunction(() => {
          const toggle = document.querySelector('input[aria-label="Auto-set daily"]')
          return toggle instanceof HTMLInputElement && !toggle.disabled
        })
        const occupied = await page.locator('[role="button"][aria-label^="Bench "]').count()
        const empty = await page.getByRole('button', { name: 'Empty bench slot', exact: true }).count()
        assert.equal(empty, Math.max(0, bench - occupied), 'Each unfilled bench place needs its own row')
        return { configuredBench: bench, occupiedBench: occupied, emptyBench: empty, memberId: me.id }
      })
      await check('offline-launch-and-write-gate', () => offline(page, context))
      await check('empty-roster-ir-taxi-zero-and-day-variants', () => checkWebEmptySlots(target, captures, {
        supabaseUrl: process.env.E2E_SUPABASE_URL, serviceRoleKey: process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY,
        anonKey: process.env.E2E_SUPABASE_PUBLISHABLE_KEY, frontendUrl: frontend,
      }))
      await check('no-runtime-errors', async () => { assert.deepEqual(result.errors, []); return [] })
    } catch (error) {
      result.checks.push({ name: 'target-session', status: 'FAIL', error: errorText(error) })
      await page.screenshot({ path: path.join(captures, 'session-failure.png') }).catch(() => {})
    } finally {
      await context.close()
      await browser.close()
      await writeFile(path.join(captures, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    }
  }
  const previous = process.env.E2E_PWA_PREVIOUS_ROOT
  if (previous) report.updates = await runWebTargetUpdates({ previousRoot: previous,
    nextRoot: process.env.E2E_PWA_NEXT_ROOT ?? path.join(root, 'dist'), artifactDir: path.join(artifactDir, 'updates'), targets: selectedTargets })
  else report.updates = { status: 'NOT_RUN', reason: 'Set E2E_PWA_PREVIOUS_ROOT to a distinct stamped export; e2e:pwa-update remains the two-build gate.' }
  report.status = report.targets.every((target) => target.checks.every((check) => check.status === 'PASS')) && report.updates.status !== 'FAIL' ? 'PASS' : 'FAIL'
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const lines = ['# Web client checks', '', report.simulation, '', `Result: ${report.status}`, '', '| Target | Check | Result | Detail |', '| --- | --- | --- | --- |',
    ...report.targets.flatMap((target) => target.checks.map((check) => `| ${target.id} | ${check.name} | ${check.status} | ${(check.error ?? '').replaceAll('|', '/').replaceAll('\n', ' ')} |`)),
    '', `Two-build update: ${report.updates.status}`, '']
  await writeFile(reportPath.replace(/\.json$/, '.md'), lines.join('\n'))
  if (report.status !== 'PASS') throw new Error(`Web client matrix failed: ${reportPath}`)
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) await runWebTargets()

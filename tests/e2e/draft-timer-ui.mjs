import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { openWebTarget, pressWebControl, waitForWebTargetReady, waitForWebTargetReads } from './web-targets-browser.mjs'
import { requireSweepLocal, requireSweepStack, resolveSweepPorts } from './layout-stability-ports.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  assert(arg.startsWith('--'))
  const split = arg.indexOf('=')
  return [arg.slice(2, split < 0 ? undefined : split), split < 0 ? true : arg.slice(split + 1)]
}))
const known = ['api-port', 'db-port', 'frontend-port', 'frontend-url', 'output-dir', 'build-sha', 'engines', 'phone-only']
for (const key of Object.keys(args)) assert(known.includes(key), `Unknown option --${key}`)
const keys = Object.fromEntries(execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
const env = { ...process.env, E2E_SUPABASE_URL: keys.API_URL, SUPABASE_DB_URL: keys.DB_URL, E2E_FRONTEND_URL: args['frontend-url'] ?? process.env.E2E_FRONTEND_URL ?? 'http://127.0.0.1:57980' }
const ports = resolveSweepPorts(args, env)
requireSweepStack(env, ports)
const origin = env.E2E_FRONTEND_URL
requireSweepLocal(origin, ports.frontend)
const output = args['output-dir'] ?? '../draft-timer-evidence'
assert(typeof output === 'string', '--output-dir requires a path')
const root = path.resolve(output)
assert(root !== process.cwd() && !root.startsWith(process.cwd() + path.sep), 'Evidence must stay outside the checkout')
await mkdir(root, { recursive: true })
const release = await fetch(`${origin}/release-provenance.json`).then(async response => {
  assert.equal(response.status, 200, 'Use a release web build')
  return response.json()
})
if (args['build-sha']) assert.equal(release.commitSha, args['build-sha'])
const engines = String(args.engines ?? 'webkit,chromium').split(',')
assert(engines.length && engines.every(engine => ['webkit', 'chromium'].includes(engine)))
const admin = createClient(keys.API_URL, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const suffix = randomUUID().replaceAll('-', '')
const password = `Synthetic-${randomUUID()}!`
const users = []
const league = randomUUID(), season = randomUUID(), openingGame = randomUUID()
const members = [randomUUID(), randomUUID()]
const checked = async operation => {
  const { data, error } = await operation
  assert.ifError(error)
  return data
}
const insert = (table, rows) => checked(admin.from(table).insert(rows))
const geometry = (page, insets) => page.evaluate(insets => {
  const nodes = [...document.querySelectorAll('[role="radiogroup"][aria-label="Rookie draft timer"] [role="radio"], [aria-label="Custom pick duration"], [role="radiogroup"][aria-label="Pick duration unit"] [role="radio"]')]
  const controls = nodes.map(node => {
    const box = node.getBoundingClientRect()
    const clipped = []
    const label = node.getAttribute('aria-label')
    if (box.width <= 0 || box.height <= 0 || box.left < 0 || box.right > innerWidth || box.top < insets.top || box.bottom > innerHeight - insets.bottom) clipped.push('safe viewport')
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), edge = parent.getBoundingClientRect()
      if (/(hidden|clip|auto|scroll)/.test(css.overflowX) && (box.left < edge.left - 0.5 || box.right > edge.right + 0.5)) clipped.push('ancestor x')
      if (/(hidden|clip|auto|scroll)/.test(css.overflowY) && (box.top < edge.top - 0.5 || box.bottom > edge.bottom + 0.5)) clipped.push('ancestor y')
    }
    for (const [x, y] of [[box.left + 4, box.top + 4], [box.right - 4, box.top + 4], [box.left + 4, box.bottom - 4], [box.right - 4, box.bottom - 4], [box.left + box.width / 2, box.top + box.height / 2]]) {
      const hit = document.elementFromPoint(x, y)
      if (!hit || !node.contains(hit)) clipped.push('covered or clipped hit point')
    }
    return { label, x: box.x, y: box.y, width: box.width, height: box.height, clipped }
  })
  return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, controls }
}, insets)
const verifyGeometry = (report, viewport) => {
  assert.equal(report.width, viewport.width)
  assert.equal(report.height, viewport.height)
  assert.equal(report.scrollWidth, viewport.width, 'The document must not scroll horizontally')
  assert.equal(report.controls.length, 9, 'All five presets, custom field, and three units must exist')
  for (const control of report.controls) assert.deepEqual(control.clipped, [], `${control.label} must be fully visible and unclipped`)
}
const reports = []
await runWithScenarioResourceOwner('draft timer UI', async () => {
  try {
    for (let n = 0; n < 2; n++) {
      const email = `timer-${n}-${suffix}@example.test`
      const result = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `timer${n}${suffix.slice(0, 12)}`, display_name: `Timer ${n}` } }))
      users.push({ id: result.user.id, email })
    }
    await insert('leagues', { id: league, name: 'Timer preview', slug: suffix, commissioner_id: users[0].id, status: 'offseason', playoff_entrants: 2, playoff_round_lengths: [1] })
    await insert('league_seasons', { id: season, league_id: league, season_year: 2189, is_current: true })
    await insert('league_members', members.map((id, n) => ({ id, league_id: league, user_id: users[n].id, role: n === 0 ? 'commissioner' : 'manager', team_name: `Timer team ${n}` })))
    await insert('draft_picks', members.flatMap(id => [1, 2, 3].map(round => ({ league_id: league, season_year: 2189, round, original_owner_id: id, current_owner_id: id }))))
    const auth = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { session } = await checked(auth.auth.signInWithPassword({ email: users[0].email, password }))
    const targets = engines.flatMap(engine => [
      { engine, mobile: true, standalone: true, viewport: { width: 393, height: 852 }, insets: { top: 59, bottom: 34 } },
      ...(args['phone-only'] ? [] : [{ engine, mobile: false, standalone: false, viewport: { width: 1440, height: 900 }, insets: { top: 0, bottom: 0 } }]),
    ])
    for (const target of targets) {
      const engine = target.engine
      const name = target.mobile ? 'iphone' : 'desktop'
      const dir = path.join(root, `${engine}-${name}`)
      await mkdir(dir, { recursive: true })
      const client = await openWebTarget(target, dir, { timezoneId: 'America/Los_Angeles', storageState: { cookies: [], origins: [{ origin, localStorage: [
        { name: `sb-${new URL(keys.API_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(session) },
        { name: `pancake:selected-league:v1:${users[0].id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: members[0] }) },
      ] }] } })
      const page = client.page
      page.setDefaultTimeout(15000)
      try {
        await page.route('**/*', async route => {
          const url = new URL(route.request().url())
          if (['http:', 'https:'].includes(url.protocol) && ![origin, keys.API_URL].includes(url.origin)) return route.abort('blockedbyclient')
          await route.continue()
        })
        await page.goto(`${origin}/league?tab=settings`)
        await waitForWebTargetReady(page)
        let taps = 0
        await pressWebControl(target, page.getByRole('tab', { name: 'Draft Board', exact: true }))
        taps++
        const sevenDays = page.getByRole('radio', { name: '604800 seconds', exact: true })
        await sevenDays.waitFor({ state: 'visible' })
        await pressWebControl(target, sevenDays)
        taps++
        await waitForWebTargetReads(page)
        assert.equal(await sevenDays.getAttribute('aria-checked'), 'true')
        const visible = await geometry(page, target.insets)
        await page.screenshot({ path: path.join(dir, `${name}-timer.png`) })
        await writeFile(path.join(dir, 'geometry.json'), JSON.stringify(visible, null, 2))
        verifyGeometry(visible, target.viewport)
        const originalStyle = await sevenDays.getAttribute('style')
        await sevenDays.evaluate(node => node.style.transform = 'translateX(-500px)')
        const bad = await geometry(page, target.insets)
        assert.throws(() => verifyGeometry(bad, target.viewport), /must be fully visible and unclipped/)
        await sevenDays.evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), originalStyle)
        verifyGeometry(await geometry(page, target.insets), target.viewport)
        const custom = page.getByRole('textbox', { name: 'Custom pick duration', exact: true })
        await custom.fill('0')
        await custom.press('Tab')
        await page.getByText('Enter 1 minute through 7 days.', { exact: true }).waitFor()
        const start = page.getByRole('button', { name: /^Start rookie draft,/ })
        assert.equal(await start.getAttribute('aria-disabled'), 'true')
        await pressWebControl(target, page.getByRole('radio', { name: 'Days', exact: true }))
        await custom.fill('8')
        await custom.press('Tab')
        await page.getByText('Enter 1 minute through 7 days.', { exact: true }).waitFor()
        await custom.fill('7')
        await custom.press('Tab')
        await pressWebControl(target, sevenDays)
        await pressWebControl(target, start)
        await page.getByText('Opening night is not published yet.', { exact: false }).waitFor()
        await page.screenshot({ path: path.join(dir, `${name}-warning.png`) })
        await pressWebControl(target, page.getByRole('button', { name: 'Cancel', exact: true }))
        await insert('nba_games', { id: openingGame, season_year: 2189, nba_game_id: '0028900035', game_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), week_number: 1, home_team: 'BOS', away_team: 'NYK', status: 'Scheduled' })
        await pressWebControl(target, start)
        await page.getByText(/could run past opening night/).waitFor()
        await page.screenshot({ path: path.join(dir, `${name}-overrun-warning.png`) })
        await pressWebControl(target, page.getByRole('button', { name: 'Cancel', exact: true }))
        await checked(admin.from('nba_games').delete().eq('id', openingGame))
        reports.push({ engine, target, tapsFromLeagueSettings: taps, geometry: visible, knownBadGeometryRejected: true, invalidRangeRejected: true, warningBeforeConfirmation: true, publishedOverrunWarning: true })
      } catch (error) {
        await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {})
        await writeFile(path.join(dir, 'failure.txt'), await page.locator('body').innerText().catch(String))
        throw error
      } finally {
        await client.context.close()
        await client.browser.close()
      }
    }
    await writeFile(path.join(root, 'ui-report.json'), JSON.stringify({ provenance: 'SYNTHETIC', release: { commitSha: release.commitSha, bundleDigest: release.bundleDigest }, reports, limitations: ['Safe areas and standalone mode use repository substitutions; no physical iOS device is tested'] }, null, 2))
    console.log(JSON.stringify(reports))
  } finally {
    await checked(admin.from('nba_games').delete().eq('id', openingGame))
    await checked(admin.from('leagues').delete().eq('id', league))
    for (const user of users) await checked(admin.auth.admin.deleteUser(user.id))
  }
})

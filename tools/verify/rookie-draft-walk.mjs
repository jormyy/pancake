#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { webkit } from 'playwright'
import { requireLocal } from './run.mjs'

const dir = path.resolve(process.argv[2] ?? '')
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.ok(run.readyAt && !run.cleanedAt)
requireLocal(run.url)
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(env.SUPABASE_DB_URL).hostname))
const credentials = JSON.parse(await readFile(path.join(run.work, 'tests/e2e-state.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'rookie-draft-fixture.json'), 'utf8'))
const out = path.join(path.dirname(dir), 'rookie-draft')
await mkdir(out, { recursive: true })
const receipts = { fixture: fixture.label, steps: [], screenshots: [], failures: [] }
const record = (step, details) => { receipts.steps.push({ step, ...details }); console.log(`${step}: ${JSON.stringify(details)}`) }
const check = (condition, message) => { if (!condition) { receipts.failures.push(message); console.log(`FAIL ${message}`) } }
const q = value => `'${String(value).replaceAll("'", "''")}'`
const db = statement => JSON.parse(execFileSync('psql', [env.SUPABASE_DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', `SELECT coalesce((${statement})::text, 'null')`], { encoding: 'utf8' }).trim())
const league = q(fixture.leagueId)
const draftId = () => db(`SELECT to_json(id) FROM drafts WHERE league_id=${league} AND draft_type='snake' AND NOT is_mock ORDER BY created_at DESC LIMIT 1`)
const board = () => db(`SELECT json_agg(json_build_object('pick',s.overall_pick,'round',s.round,'slotTeam',slot.team_name,'original',orig.team_name,'owner',cur.team_name,'player',p.display_name,'picked',s.picked_at IS NOT NULL) ORDER BY s.overall_pick)
  FROM snake_draft_picks s JOIN draft_picks dp ON dp.id=s.draft_pick_id JOIN league_members slot ON slot.id=s.member_id
  JOIN league_members orig ON orig.id=dp.original_owner_id JOIN league_members cur ON cur.id=dp.current_owner_id LEFT JOIN players p ON p.id=s.player_id
  WHERE s.draft_id=${q(draftId())}`)
const roster = team => db(`SELECT json_build_object('active',count(*) FILTER (WHERE NOT r.is_on_taxi AND NOT r.is_on_ir),'taxi',count(*) FILTER (WHERE r.is_on_taxi),
  'players',json_agg(p.display_name || CASE WHEN r.is_on_taxi THEN ' (taxi)' ELSE '' END ORDER BY p.display_name))
  FROM roster_players r JOIN league_members m ON m.id=r.member_id JOIN players p ON p.id=r.player_id WHERE r.league_id=${league} AND m.team_name=${q(team)}`)
const swaps = () => db(`SELECT json_agg(json_build_object('round',round,'holder',h.team_name,'counterparty',c.team_name,'status',status,'holderPick',holder_overall_pick,'counterpartyPick',counterparty_overall_pick) ORDER BY round)
  FROM draft_pick_swaps s JOIN league_members h ON h.id=s.holder_member_id JOIN league_members c ON c.id=s.counterparty_member_id WHERE s.league_id=${league}`)
const receiptsCount = () => db(`SELECT count(*) FROM private.request_receipts WHERE function = 'public.make_rookie_selection_atomic' AND created_at > now() - interval '1 hour'`)
const pickState = () => ({ board: board(), alpha: roster('Alpha'), beta: roster('Beta') })

const browser = await webkit.launch({ headless: true })
const session = async (name, userIndex, width, height) => {
  const touch = width < 960
  const context = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const user = credentials.users[userIndex]
  await page.goto(run.url + '/sign-in')
  await page.waitForLoadState('networkidle')
  await page.getByPlaceholder('you@example.com').filter({ visible: true }).fill(user.email)
  await page.getByPlaceholder('Your password').filter({ visible: true }).fill(credentials.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).filter({ visible: true }).click()
  await page.waitForURL(url => !url.pathname.includes('sign-in'))
  return { name, page, context, touch, width }
}
const control = (s, name, role = 'button') => s.page.getByRole(role, { name, exact: true }).filter({ visible: true }).first()
const activate = async (s, target) => { if (s.touch) await target.tap(); else await target.click() }
const press = async (s, name, role = 'button') => { const target = control(s, name, role); await target.waitFor(); await activate(s, target) }
const text = async (s, value) => s.page.getByText(value, { exact: false }).filter({ visible: true }).first().waitFor()
const settle = s => s.page.waitForTimeout(1200)
const shot = async (s, label) => {
  assert.equal(await s.page.locator('input[type="password"]').evaluateAll(nodes => nodes.some(node => node.value)), false)
  const file = path.join(out, `${label}-${s.width}.png`)
  await s.page.screenshot({ path: file })
  await writeFile(file.replace(/\.png$/, '.txt'), await s.page.locator('body').ariaSnapshot())
  const layout = await s.page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  check(layout.scrollWidth <= layout.width + 1, `${label}-${s.width} overflows horizontally (${layout.scrollWidth} > ${layout.width})`)
  receipts.screenshots.push(file)
}
const switchLeague = async (s, name) => {
  await press(s, 'Switch league')
  await press(s, `Switch to ${name}`)
  await s.page.waitForTimeout(800)
}
const openDraftTab = async s => {
  await press(s, 'League', 'link')
  await settle(s)
  const panel = s.page.getByRole('tabpanel', { name: 'Draft league section' }).filter({ visible: true })
  if (!(await panel.count())) await press(s, 'Draft')
  await panel.first().waitFor()
  await settle(s)
}
const openRoom = async s => {
  const join = s.page.getByRole('button', { name: /^(Join|Resume) Rookie Draft$|^View Rookie Draft Results$|^Resolve Rookie Draft$/ }).filter({ visible: true }).first()
  await join.waitFor()
  await activate(s, join)
  await s.page.waitForURL(url => url.pathname.includes('rookie-draft-room'))
  await settle(s)
}
const showProspects = async s => { if (await control(s, 'Show prospects').count()) await press(s, 'Show prospects'); await settle(s) }
const showBoard = async s => { if (await control(s, 'Show pick board').count()) await press(s, 'Show pick board'); await settle(s) }
const visibleNames = async s => s.page.locator('[aria-label]').filter({ visible: true }).evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))

const alpha = await session('alpha-phone', 0, 390, 844)
const alphaDesk = await session('alpha-desktop', 0, 1440, 1000)
const beta = await session('beta-phone', 1, 390, 844)
const betaDesk = await session('beta-desktop', 1, 1440, 1000)
const e2eLeague = db(`SELECT to_json(name) FROM leagues WHERE id=${q(credentials.leagueId)}`)

for (const s of [alpha, alphaDesk, beta, betaDesk]) {
  await switchLeague(s, fixture.label)
  await openDraftTab(s)
  await shot(s, `01-entry-upcoming-${s.name.split('-')[0]}`)
}
await switchLeague(alpha, e2eLeague)
await openDraftTab(alpha)
await shot(alpha, '02-switch-other-league-draft')
const otherLeagueLabels = await visibleNames(alpha)
check(!otherLeagueLabels.some(label => /Start rookie draft/.test(label ?? '')), 'Other league shows the rehearsal league draft setup')
await switchLeague(alpha, fixture.label)
await openDraftTab(alpha)
check(await control(alpha, 'Start Rookie Draft').count() + await alpha.page.getByRole('button', { name: /^Start rookie draft/ }).count() > 0, 'Switching back does not show the rehearsal setup')
record('entry', { upcomingShown: true, otherLeague: e2eLeague })

alpha.page.on('dialog', dialog => dialog.accept())
await press(alpha, '3600 seconds', 'radio')
await press(alpha, 'Pause', 'radio')
const start = alpha.page.getByRole('button', { name: /^Start rookie draft/ }).filter({ visible: true }).first()
await activate(alpha, start)
const confirmStart = alpha.page.getByRole('button', { name: /^Start Rookie$/ }).filter({ visible: true })
await confirmStart.first().waitFor({ timeout: 5000 }).then(() => activate(alpha, confirmStart.first())).catch(() => {})
await alpha.page.waitForTimeout(2500)
const started = draftId()
check(started, 'Rookie draft did not start')
record('start', { draftId: started, swaps: swaps(), board: board() })

for (const s of [alpha, alphaDesk, beta, betaDesk]) {
  await s.page.reload()
  await s.page.waitForLoadState('networkidle')
  await openDraftTab(s)
  await shot(s, `03-entry-live-${s.name.split('-')[0]}`)
  await openRoom(s)
}
for (const s of [alpha, alphaDesk, beta, betaDesk]) {
  await showBoard(s)
  await shot(s, `04-board-traded-swapped-${s.name.split('-')[0]}`)
}
const alphaBoardLabels = await visibleNames(alphaDesk)
check(alphaBoardLabels.some(label => /swapped picks with/.test(label ?? '')), 'Board does not describe the exercised swap')
check(alphaBoardLabels.some(label => /swap with .* was not better/.test(label ?? '')), 'Board does not describe the unused swap')
const boardText = await alphaDesk.page.locator('body').innerText()
check(/via Alpha/.test(boardText), 'Board does not show the traded pick via Alpha')
check(/Up next/.test(boardText), 'Room does not show the next manager')

await showProspects(alpha)
const prospectText = await alpha.page.locator('body').innerText()
for (const decoy of [...fixture.decoys, fixture.unavailable, 'E2E Player005']) check(!prospectText.includes(decoy), `Prospect list shows ineligible ${decoy}`)
check(prospectText.includes('E2E Player001'), 'Prospect list misses E2E Player001')
const pool = db(`SELECT json_agg(p.display_name ORDER BY pool.draft_overall_pick) FROM private.rookie_draft_pool(${q(started)}) pool JOIN players p ON p.id=pool.player_id`)
record('pool', { pool, excluded: [...fixture.decoys, fixture.unavailable, 'E2E Player005'] })
await shot(alpha, '05-prospects-eligible-alpha')

const betaLabels = await visibleNames(beta)
check(!betaLabels.some(label => /^Select /.test(label ?? '')), 'Beta can select while Alpha is on the clock')

const before = pickState()
await press(alpha, 'Select E2E Player001')
await text(alpha, 'After this pick')
await shot(alpha, '06-placement-full-active-alpha')
check(await control(alpha, 'Confirm drafting E2E Player001').isDisabled(), 'Confirm is enabled while the active roster is over the limit')
await press(alpha, 'Cancel this pick')
await settle(alpha)
check(JSON.stringify(pickState()) === JSON.stringify(before), 'Cancel changed stored state')
record('cancel', { unchanged: true })

const betaSession = await (await fetch(`${env.E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: env.E2E_SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ email: credentials.users[1].email, password: credentials.password }),
})).json()
const unauthorized = await fetch(`${env.E2E_API_BASE_URL}/draft/${started}/rookie-selection`, {
  method: 'POST', headers: { authorization: `Bearer ${betaSession.access_token}`, apikey: env.E2E_SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json', 'x-request-id': crypto.randomUUID() },
  body: JSON.stringify({ memberId: fixture.beta.memberId, playerId: db(`SELECT to_json(id) FROM players WHERE display_name='E2E Player002'`), destination: 'active', dropRosterPlayerIds: [] }),
})
const unauthorizedBody = await unauthorized.text()
check(unauthorized.status >= 400, `Beta out-of-turn selection was accepted (${unauthorized.status})`)
check(JSON.stringify(pickState()) === JSON.stringify(before), 'Refused out-of-turn selection changed stored state')
record('unauthorized', { status: unauthorized.status, body: unauthorizedBody.slice(0, 200), unchanged: true })

await press(alphaDesk, 'Select E2E Player001')
await text(alphaDesk, 'After this pick')
await press(alphaDesk, 'Drop Rehearsal Vet A1', 'checkbox').catch(() => press(alphaDesk, 'Drop Rehearsal Vet A1'))
await settle(alphaDesk)
await shot(alphaDesk, '07-placement-drop-chosen-alpha')
const confirm1 = control(alphaDesk, 'Confirm drafting E2E Player001')
await Promise.all([confirm1.click(), confirm1.click({ force: true }).catch(() => {})])
await alphaDesk.page.waitForTimeout(3000)
await shot(alphaDesk, '08-result-active-with-drop-alpha')
const afterPick1 = pickState()
check(afterPick1.board[0].player === 'E2E Player001', 'Pick 1 is not E2E Player001')
check(afterPick1.board.filter(row => row.player === 'E2E Player001').length === 1, 'Double tap stored the pick twice')
check(!afterPick1.alpha.players.includes('Rehearsal Vet A1'), 'Chosen drop is still on Alpha')
check(afterPick1.alpha.active === 6, `Alpha active roster is ${afterPick1.alpha.active}, expected 6`)
record('pick1', { doubleTap: true, alpha: afterPick1.alpha, receipts: receiptsCount() })

await beta.page.waitForTimeout(2500)
await showProspects(beta)
await press(beta, 'Select E2E Player002')
await text(beta, 'After this pick')
await press(beta, 'Taxi', 'radio').catch(() => press(beta, 'Taxi', 'tab')).catch(() => press(beta, 'Taxi'))
await settle(beta)
await shot(beta, '09-placement-taxi-beta')
await press(beta, 'Confirm drafting E2E Player002')
await beta.page.waitForTimeout(3000)
await shot(beta, '10-result-taxi-beta')
const afterPick2 = pickState()
check(afterPick2.beta.players.includes('E2E Player002 (taxi)'), 'Pick 2 did not land on Beta taxi')
record('pick2', { beta: afterPick2.beta })

await alpha.page.waitForTimeout(2500)
await showProspects(alpha)
await press(alpha, 'Select E2E Player003')
await text(alpha, 'After this pick')
await press(alpha, 'Taxi', 'radio').catch(() => press(alpha, 'Taxi', 'tab')).catch(() => press(alpha, 'Taxi'))
await settle(alpha)
await shot(alpha, '11-placement-full-taxi-alpha')
await press(alpha, 'Drop rookie', 'radio').catch(() => press(alpha, 'Drop rookie', 'tab')).catch(() => press(alpha, 'Drop rookie'))
await settle(alpha)
await shot(alpha, '12-placement-drop-rookie-alpha')
await press(alpha, 'Confirm drafting E2E Player003')
await alpha.page.waitForTimeout(3000)
await shot(alpha, '13-result-drop-rookie-alpha')
const afterPick3 = pickState()
check(afterPick3.board[2].player === 'E2E Player003', 'Dropped rookie did not use pick 3')
check(!afterPick3.alpha.players.some(name => name.startsWith('E2E Player003')), 'Dropped rookie is on Alpha roster')
record('pick3', { alpha: afterPick3.alpha, pick: afterPick3.board[2] })

await beta.context.setOffline(true)
await beta.page.waitForTimeout(2000)
await beta.context.setOffline(false)
await alpha.page.reload()
await alpha.page.waitForLoadState('networkidle')
await settle(alpha)
await beta.page.waitForTimeout(4000)
await showBoard(beta)
await shot(beta, '14-reconnected-board-beta')
await showBoard(alpha)
await shot(alpha, '15-refreshed-board-alpha')
record('reconnect', { betaOfflineThenOnline: true, alphaRefreshed: true })

for (const [name, drop] of [['E2E Player004', null], ['E2E Player006', null], ['E2E Player007', 'Rehearsal Vet B1']]) {
  await beta.page.waitForTimeout(2000)
  await showProspects(beta)
  await press(beta, `Select ${name}`)
  await text(beta, 'After this pick')
  if (drop) {
    await shot(beta, '16-placement-full-active-beta')
    await press(beta, `Drop ${drop}`, 'checkbox').catch(() => press(beta, `Drop ${drop}`))
    await settle(beta)
  }
  await press(beta, `Confirm drafting ${name}`)
  await beta.page.waitForTimeout(3000)
}
await shot(beta, '17-result-final-beta')
const final = pickState()
record('final', final)
check(final.board.every(row => row.picked), 'Draft has unpicked slots')
check(final.beta.active <= fixture.limits.active && final.beta.taxi <= fixture.limits.taxi, 'Beta roster is over the limit')
check(final.alpha.active <= fixture.limits.active && final.alpha.taxi <= fixture.limits.taxi, 'Alpha roster is over the limit')

const boards = {}
for (const s of [alpha, beta, alphaDesk, betaDesk]) {
  await s.page.reload()
  await s.page.waitForLoadState('networkidle')
  await openDraftTab(s)
  await shot(s, `18-entry-results-${s.name.split('-')[0]}`)
  await openRoom(s)
  await showBoard(s)
  await shot(s, `19-results-board-${s.name.split('-')[0]}`)
  boards[s.name] = (await s.page.locator('body').innerText()).match(/Pick \d+[\s\S]*?(?=Pick \d+|$)/g)?.map(row => row.replace(/\s+/g, ' ').trim())
}
check(JSON.stringify(boards['alpha-desktop']) === JSON.stringify(boards['beta-desktop']), 'Alpha and Beta desktop boards differ')
record('agreement', { alphaDesktop: boards['alpha-desktop'], betaDesktop: boards['beta-desktop'] })

for (const s of [alpha, alphaDesk]) {
  await press(s, 'Back to league drafts').catch(() => s.page.goto(run.url + '/league'))
  await press(s, 'Roster', 'link')
  await settle(s)
  await shot(s, '20-reference-roster-alpha')
  await press(s, 'Matchup', 'link')
  await settle(s)
  await shot(s, '21-reference-matchup-alpha')
}

receipts.swaps = swaps()
receipts.selectionReceipts = receiptsCount()
await writeFile(path.join(out, 'walk.json'), JSON.stringify(receipts, null, 2) + '\n')
await browser.close()
console.log(receipts.failures.length ? `FAILURES ${receipts.failures.length}` : 'PASS')
process.exitCode = receipts.failures.length ? 1 : 0

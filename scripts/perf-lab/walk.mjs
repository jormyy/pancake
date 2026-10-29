import assert from 'node:assert/strict'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { webkit } from 'playwright'
import { digest, json, safeHeaders, publicUrl } from './common.mjs'
import { statementSnapshot, statementDelta, sql } from './database.mjs'
import { inventory } from './workloads.mjs'
import { summarizeAccess } from './capture.mjs'
import { trafficBreakdown } from './traffic.mjs'
import { performAction, expectContent } from './actions.mjs'
import { expectedSurface } from './surfaces.mjs'
import { withScenarioFixtures, withScenarioSetup } from '../ios-sim/seed.mjs'
import { withDayPhase } from './phases.mjs'
import { changeForScreen } from './server-change.mjs'
import { selectedSurfaces, workloadSelection } from './selection.mjs'
import { accumulatedReceipts, verifyArtifacts } from './report.mjs'
import { controlContract, interactionMeasurement, leafControls, observeSearch, visibleControls } from './interactions.mjs'
import { observeRenderChanges, renderSummary } from './control-observer.mjs'
import { networkProxy } from './network-proxy.mjs'
import { settleControl } from './settle.mjs'
import { phoneProfile, emulateStandalone, phoneEvidence } from './device.mjs'
import { emptyPlan, withEmptyState } from './empty.mjs'
import { playerViewReady } from './player-results.mjs'

export function substitute(value, context) {
  if (Array.isArray(value)) return value.map(item => substitute(item, context))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, context)]))
  if (typeof value !== 'string') return value
  return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const result = key.split('.').reduce((object, field) => object?.[field], context)
    assert.ok(result !== undefined, `Missing fixture ${key}`)
    return String(result)
  })
}

export async function prepareObservationDirectory(directory) {
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
}

export function redactHar(har, startedAt = 0) {
  har.log.entries = har.log.entries.filter(entry => Date.parse(entry.startedDateTime) >= startedAt).map(entry => ({ ...entry,
    request: { ...entry.request, url: publicUrl(entry.request.url), headers: Object.entries(safeHeaders(Object.fromEntries(entry.request.headers.map(row => [row.name.toLowerCase(), row.value])))).map(([name, value]) => ({ name, value })), cookies: [], queryString: entry.request.queryString.map(row => ({ name: row.name, value: '[redacted]' })), postData: undefined },
    response: { ...entry.response, headers: Object.entries(safeHeaders(Object.fromEntries(entry.response.headers.map(row => [row.name.toLowerCase(), row.value])))).map(([name, value]) => ({ name, value })), cookies: [], content: { ...entry.response.content, text: undefined } },
  }))
  return har
}

export function installContentProbe(expected) {
  let queued = false
  const visible = element => {
    if (!element?.getClientRects().length) return false
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false
    }
    return true
  }
  const matches = item => {
    const value = item.value === undefined ? null : typeof item.value === 'object' && item.value !== null ? item.value : { selector: item.selector, equals: item.value }
    const textRoot = item.within ? document.querySelector(item.within) : document.body
    return (!item.all || item.all.every(matches)) && (!item.any || item.any.some(matches))
      && (!item.selector || [...document.querySelectorAll(item.selector)].some(visible))
      && (!item.text || textRoot?.innerText.includes(item.text) && (!item.within || visible(textRoot)))
      && (!value || [...document.querySelectorAll(value.selector)].some(element => visible(element) && element.value === String(value.equals)))
      && (!item.playerView || window.__perfLabPlayerViewReady?.(item.playerView))
      && Boolean(item.all?.length || item.any?.length || item.selector || item.text || value || item.playerView)
  }
  const check = () => {
    if (queued) return
    const matched = matches(expected)
    if (!matched) return
    queued = true
    requestAnimationFrame(() => { window.__perfLabFirstContentMs = performance.now() })
    observer.disconnect()
  }
  const observer = new MutationObserver(check)
  observer.observe(document, { childList: true, subtree: true, attributes: true })
  document.addEventListener('DOMContentLoaded', check, { once: true })
}

async function content(page, expected) { return expectContent(page, expected, page.url()) }

async function signedInState(browser, origin, fixture, manager, evidence) {
  const context = await browser.newContext({ ...phoneProfile, ignoreHTTPSErrors: true })
  await context.addInitScript(emulateStandalone)
  let page
  const errors = []
  try {
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/sign-in`)
    await page.locator('#root').getByPlaceholder('you@example.com').fill(fixture.users[manager].email)
    await page.locator('#root').getByPlaceholder('Your password').fill(fixture.password)
    await page.locator('#root').getByRole('button', { name: 'Sign In', exact: true }).click()
    await page.getByText(fixture.users[manager].teamName, { exact: false }).first().waitFor({ timeout: 20000 })
    const storage = await context.storageState()
    const auth = storage.origins.flatMap(row => row.localStorage).find(row => row.name.endsWith('-auth-token'))
    assert.equal(JSON.parse(auth.value).user.id, fixture.users[manager].id, 'Browser has the expected manager identity')
    return { cookies: [], origins: storage.origins.map(row => ({ ...row, localStorage: row.localStorage.filter(item => item.name.endsWith('-auth-token')) })) }
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(evidence, `auth-failure-${manager}.png`) }).catch(() => {})
      await json(path.join(evidence, `auth-failure-${manager}.json`), { error: error.message, page: page.url(), errors, text: await page.locator('body').innerText().catch(() => '') })
    }
    throw error
  } finally { await context.close() }
}

const scenarioNeedsStack = scenario => Boolean(scenario?.setup)

export async function walk({ origin, fixture, capture, evidence, stack, limit = Infinity }) {
  const work = await inventory()
  const receipts = []
  const selection = workloadSelection()
  const deadline = selection.seconds ? Date.now() + selection.seconds * 1000 : Infinity
  const finished = () => receipts.length >= limit || Date.now() >= deadline || selection.stopOnFailure && receipts.at(-1)?.webkit?.passed === false
  const completed = new Set()
  for (const previous of await accumulatedReceipts(evidence, [], work.fingerprint)) {
    if (previous.webkit?.passed && previous.webkit?.firstFrameReady && !(await verifyArtifacts(previous, evidence)).length) completed.add(previous.id)
  }
  const baseSurfaces = selectedSurfaces(work, selection)
  assert.ok(!selection.surfaces || selection.surfaces.every(id => work.surfaces.some(surface => surface.id === id)), 'Unknown requested surface')
  const proxy = await networkProxy(origin)
  let browser
  try {
    browser = await webkit.launch({ headless: true, proxy: { server: proxy.url } })
    await json(path.join(evidence, 'workload-selection.json'), selection)
    for (const [manager, role] of ['commissioner', 'member'].entries()) {
      if (!selection.roles.includes(role)) continue
      let storageState = await signedInState(browser, origin, fixture, manager, evidence)
      const memberId = fixture.members[manager].id
      const variables = { leagueId: fixture.leagueId, userEmail: fixture.users[manager].email, userPassword: fixture.password, teamName: fixture.users[manager].teamName, displayName: fixture.users[manager].displayName,
        otherTeam: fixture.users[manager ^ 1].teamName, rosterPlayer: fixture.players[manager * 22], freeAgent: fixture.players[220 + manager],
        waiverPlayer: fixture.players[230 + manager], memberId, otherMemberId: fixture.members[manager ^ 1].id,
        benchPlayer: fixture.players[manager * 22 + 10], outPlayer: fixture.players[240 + manager], liveFreeAgent: fixture.players[222], lineupSlot: 'PG',
        liveAuctionId: fixture.drafts.find(draft => draft.draft_type === 'auction')?.id, rosterPlanTradeId: fixture.rosterPlanTrade.id,
        tradeTarget: { player: fixture.players[66], teamName: fixture.users[3].teamName }, weekOffLeagueName: `Home week-off ${memberId.slice(0, 8)}` }
      const matchupId = await sql(`SELECT id FROM matchups WHERE league_id='${fixture.leagueId}' AND (home_member_id='${memberId}' OR away_member_id='${memberId}') ORDER BY id LIMIT 1`)
      for (const day of selection.days) {
      const phaseSurfaces = new Set(selectedSurfaces(work, selection, { role, day }).map(surface => surface.id))
      await withDayPhase(fixture, day, async dayEvidence => {
      for (const surface of baseSurfaces) {
        if (!phaseSurfaces.has(surface.id)) continue
        const template = work.scenarios.find(scenario => scenario.name === surface.scenario)
        const runSurface = async (drafts = {}) => {
        const scenario = template ? substitute(template, { ...variables, draftId: drafts[template.setup?.draftRoom] }) : null
        for (const state of selection.states) {
          if (finished()) return receipts
          const row = work.rows.find(row => row.surface === surface.id && row.role === role && row.day === day && row.state === state)
          if (selection.cases && !selection.cases.includes(row.id)) continue
          if (completed.has(row.id)) continue
          if (state === 'empty' && !emptyPlan(surface)) {
            const proof = { role, passed: false, failure: `Empty-state fixture is not implemented for ${surface.id}` }
            receipts.push({ ...row, fingerprint: work.fingerprint, webkit: proof })
            await json(path.join(evidence, 'walk.json'), receipts)
            console.log(JSON.stringify({ screen: surface.id, role, state, ...proof }))
            continue
          }
          const observe = async emptyFixture => {
          const name = row.id.replaceAll('/', '--')
          const directory = path.join(evidence, name)
          await prepareObservationDirectory(directory)
          const harFile = path.join(directory, 'raw.har')
          const context = await browser.newContext({ ...phoneProfile, ignoreHTTPSErrors: true,
            storageState: surface.id.startsWith('auth-') || ['/sign-in', '/sign-up'].includes(scenario?.from) ? undefined : storageState, recordHar: { path: harFile, content: 'omit', mode: 'full' } })
          await context.addInitScript(emulateStandalone)
          await context.addInitScript(`window.__perfLabPlayerViewReady = (${playerViewReady.toString()});`)
          const page = await context.newPage()
          const blockedBefore = proxy.blocked.length
          const denied = []
          const draftId = fixture.drafts.find(draft => draft.draft_type === (surface.id === 'rookie-draft-room' ? 'snake' : 'auction'))?.id
          const pathname = surface.route.replace(':matchupId', matchupId).replace(':id', surface.route.startsWith('/player/') || surface.route.startsWith('/claim-player') ? variables.freeAgent.id : surface.route.startsWith('/team-roster') ? variables.otherMemberId : draftId)
          const expected = emptyFixture?.expected ?? (scenario ? scenario.steps[surface.step].expected : expectedSurface(surface, variables, role))
          const targetControl = scenario ? `${scenario.name}/${surface.step}/${leafControls(scenario.steps[surface.step].action).at(-1).path}` : null
          const firstFrame = async () => {
            if (proof.firstFrameReady) return
            await page.waitForFunction(() => ['pancake-boot-shell', 'root'].some(id => {
              const element = document.getElementById(id)
              const style = element && getComputedStyle(element)
              return element?.getClientRects().length && style.visibility !== 'hidden' && style.opacity !== '0'
                && (element.textContent?.trim() || element.querySelector('img,svg,input,button'))
            }), null, { timeout: 10000 })
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            await page.screenshot({ path: path.join(directory, 'first.png'), timeout: 10000 })
            proof.firstFrameReady = true
          }
          const actionCapture = { active: false, controls: [], current: null, statements: null }
          const hooks = prefix => ({
            before: async (action, trace) => {
              const control = { id: `${prefix}/${trace}`, ...controlContract(action), window: `${row.id}/control/${prefix}/${trace}`, startedAt: Date.now(), keystrokes: [] }
              actionCapture.current = control
              if (control.kind === 'fill' && control.label === 'Search players') {
                await page.locator('#root').waitFor({ state: 'attached', timeout: 15000 })
                await page.evaluate(observeSearch)
              }
              if (!actionCapture.active) return
              actionCapture.controls.push(control)
              actionCapture.statements = await statementSnapshot()
              capture.mark(control.window)
            },
            after: async (_action, _trace, succeeded) => {
              if (!actionCapture.current) return
              const control = actionCapture.current
              control.actionEndedAt = Date.now()
              control.actionCompleted = succeeded
              if (succeeded) {
                if (actionCapture.active && control.id === targetControl) await firstFrame()
                await settleControl(page, control)
              }
              if (!actionCapture.active) return
              control.settledAt = Date.now()
              control.statements = statementDelta(actionCapture.statements, await statementSnapshot())
              control.dbCalls = control.statements.reduce((sum, row) => sum + row.calls, 0)
              control.dbRows = control.statements.reduce((sum, row) => sum + row.rows, 0)
              control.dbMs = control.statements.filter(row => row.toplevel).reduce((sum, row) => sum + row.total_exec_time, 0)
              control.dbBuffers = control.statements.filter(row => row.toplevel).reduce((sum, row) => sum + row.shared_blks_hit + row.shared_blks_read, 0)
              Object.assign(control, renderSummary(await page.evaluate(() => window.__perfLabRenderEvents), control.startedAt, control.settledAt))
            },
            keystroke: async (_action, _trace, index, value) => {
              const control = actionCapture.current
              const key = { index, value, at: Date.now(), window: `${control.window}/key/${index}` }
              control.keystrokes.push(key)
              if (actionCapture.active) capture.mark(key.window)
            },
          })
          const openSurface = async (options) => {
            if (!scenario) {
              await page.goto(origin + pathname, options)
              for (const action of emptyFixture?.actions ?? []) await performAction(page, context, origin, action, hooks(`empty/${surface.id}`))
              return
            }
            await page.goto(origin + scenario.from, options)
            await page.waitForLoadState('domcontentloaded')
            await page.waitForFunction(() => (document.getElementById('root')?.innerText.trim().length ?? 0) > 20, null, { timeout: 15000 })
            await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
            for (const [index, action] of (scenario.prepare ?? []).entries()) await performAction(page, context, origin, action, hooks(`${scenario.name}/prepare/${index}`))
            for (const [index, step] of scenario.steps.entries()) {
              await performAction(page, context, origin, step.action, hooks(`${scenario.name}/${index}`))
              if (index === surface.step) break
              await expectContent(page, step.expected, origin)
              if (actionCapture.active && actionCapture.current) { actionCapture.current.settledAt = Date.now(); actionCapture.current.expectedReached = true }
            }
          }
          await context.addInitScript(installContentProbe, expected)
          await context.addInitScript(observeRenderChanges)
          const proof = { role, passed: false, denied, httpCache: 'enabled', networkGuard: 'loopback-proxy', dayEvidence, finalDay: day === 'final' && dayEvidence.final === dayEvidence.games }
          let before, startedAt, serverChange
          try {
            if (!['cold', 'empty'].includes(state)) {
              await openSurface()
              await content(page, expected)
              await page.evaluate(async () => {
                await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker did not become ready')), 10000))])
              })
              await openSurface({ waitUntil: 'domcontentloaded' })
              await content(page, expected)
              assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'Warm and offline captures require a controlling worker')
              if (state === 'offline') await context.setOffline(true)
            }
            actionCapture.active = true
            capture.mark(row.id)
            if (state === 'error') capture.failRefresh(row.id)
            before = await statementSnapshot()
            startedAt = Date.now()
            await openSurface({ waitUntil: 'commit', timeout: 20000 })
            await firstFrame()
            proof.phone = await page.evaluate(phoneEvidence)
            if (state === 'server-change') {
              serverChange = await changeForScreen(surface, fixture, variables, { verify: expected => expectContent(page, expected, origin) })
              proof.serverChange = serverChange.evidence
              await performAction(page, context, origin, { background: true })
              await expectContent(page, serverChange.expected, origin)
              proof.observedChange = true
            } else await content(page, expected)
            proof.emptyContent = state === 'empty' && Boolean(emptyFixture)
            if (emptyFixture) proof.emptyFixture = emptyFixture.evidence
            if (actionCapture.current?.kind === 'fill' && actionCapture.current.label === 'Search players') {
              const last = actionCapture.current.keystrokes.at(-1)
              await page.waitForFunction(({ value, at }) => Date.now() - at >= 300
                && window.__perfLabSearch.some(result => result.query === value && result.at >= at && result.ready), last, { timeout: 15000 })
            }
            if (actionCapture.current) { actionCapture.current.settledAt = Date.now(); actionCapture.current.expectedReached = true }
            const firstContent = await page.evaluate(() => window.__perfLabFirstContentMs ?? null)
            proof.firstContentMs = firstContent ?? Date.now() - startedAt
            proof.timingSource = firstContent === null ? 'automation upper bound' : 'document animation frame'
            await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
            await page.locator('#root [role="progressbar"]').first().waitFor({ state: 'hidden', timeout: 15000 })
            if (actionCapture.current) actionCapture.current.settledAt = Date.now()
            proof.settledMs = await page.evaluate(() => performance.now())
            await page.screenshot({ path: path.join(directory, 'settled.png'), timeout: 10000 })
            proof.controls = await page.evaluate(visibleControls)
            proof.searchResults = await page.evaluate(() => window.__perfLabSearch ?? [])
            const cache = await page.evaluate(() => window.__perfLab?.events ?? null)
            assert.ok(Array.isArray(cache), 'The page cache observer did not load')
            await json(path.join(directory, 'cache.json'), cache)
            proof.cacheHits = cache.filter(row => row.hit === true).length
            proof.cacheMisses = cache.filter(row => row.hit === false).length
            proof.invalidations = cache.filter(row => row.cacheAction === 'invalidated' || row.operation === 'delete').length
            proof.offlineContent = state === 'offline'
            denied.push(...proxy.blocked.slice(blockedBefore))
            proof.passed = denied.length === 0
          } catch (error) {
            proof.failure = error.message
            await json(path.join(directory, 'failure.json'), { message: error.message, url: publicUrl(page.url()), text: await page.locator('body').innerText().catch(() => ''), controls: await page.evaluate(visibleControls).catch(() => []) })
            await page.screenshot({ path: path.join(directory, 'failure.png'), timeout: 10000 }).catch(() => {})
          } finally {
            const rows = capture.rows(row.id)
            Object.assign(proof, summarizeAccess(rows.access))
            proof.interactions = actionCapture.controls.map(control => interactionMeasurement(control, rows.access, control.settledAt ?? control.actionEndedAt ?? Date.now(), proof.searchResults ?? []))
            await json(path.join(directory, 'interactions.json'), { controls: proof.controls ?? [], interactions: proof.interactions, searchResults: proof.searchResults ?? [] })
            proof.traffic = trafficBreakdown(rows.access)
            await json(path.join(directory, 'access.json'), rows.access)
            let statements = null
            try {
              if (before) statements = statementDelta(before, await statementSnapshot())
            } catch (error) { proof.failure = error.message; proof.passed = false }
            proof.dbCalls = statements?.reduce((sum, item) => sum + item.calls, 0) ?? null
            proof.dbRows = statements?.reduce((sum, item) => sum + item.rows, 0) ?? null
            proof.dbMs = statements?.filter(item => item.toplevel).reduce((sum, item) => sum + item.total_exec_time, 0) ?? null
            proof.dbBuffers = statements?.filter(item => item.toplevel).reduce((sum, item) => sum + item.shared_blks_hit + item.shared_blks_read, 0) ?? null
            proof.errorExercised = state === 'error' && rows.access.some(row => row.injected && row.status === 503)
            if (state === 'error' && !proof.errorExercised) { proof.passed = false; proof.failure ??= 'No backend refresh exercised the injected error' }
            if (proof.errors && state !== 'error') { proof.passed = false; proof.failure ??= 'Unexpected HTTP errors in the capture' }
            capture.clearFault()
            proof.pushBytes = rows.realtime.reduce((sum, item) => sum + item.bytes, 0)
            await json(path.join(directory, 'db.json'), statements)
            await json(path.join(directory, 'push.json'), rows.realtime)
            await context.close()
            await serverChange?.undo()
            await json(path.join(directory, 'screen.har'), redactHar(JSON.parse(await readFile(harFile, 'utf8')), startedAt))
            await rm(harFile)
            proof.hashes = {}
            for (const [key, file] of Object.entries({ har: 'screen.har', firstScreenshot: 'first.png', settledScreenshot: 'settled.png', failureScreenshot: 'failure.png', dbEvidence: 'db.json', cacheEvidence: 'cache.json', pushEvidence: 'push.json' })) {
              const bytes = await readFile(path.join(directory, file)).catch(() => null)
              if (bytes) { proof[key] = `${name}/${file}`; proof.hashes[key] = digest(bytes) }
            }
            receipts.push({ ...row, fingerprint: work.fingerprint, webkit: proof })
            await json(path.join(evidence, 'walk.json'), receipts)
            console.log(JSON.stringify({ screen: surface.id, role, state, passed: proof.passed, requests: proof.requests, bytesIn: proof.bytesIn, failure: proof.failure }))
          }
          }
          if (state === 'empty') await withEmptyState(surface, fixture, variables, observe)
          else await observe(null)
        }
        }
        if (scenarioNeedsStack(template)) {
          assert.ok(stack, 'Interaction fixtures need the local stack')
          await withScenarioFixtures(stack, [template], drafts => withScenarioSetup(stack, substitute(template.setup ?? null, { ...variables, draftId: drafts[template.setup?.draftRoom] }), () => runSurface(drafts)))
        } else await runSurface()
        if (template?.name === 'shell-auth-sign-out') storageState = await signedInState(browser, origin, fixture, manager, evidence)
        if (finished()) return receipts
      }
      })
      if (finished()) return receipts
      }
    }
    return receipts
  } finally { try { await browser?.close() } finally { await proxy.close() } }
}

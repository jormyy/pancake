import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { exportWeb, verifyBuild } from './build.mjs'
import { args, digest, freePort, home, lock, pause, repo, run, stopChild } from './common.mjs'
import { installPwa, simulator, startDriver } from './driver.mjs'
import { failures, videoDifferences, writeReport } from './report.mjs'
import { serve } from './server.mjs'
import { withScenarioFixtures, withScenarioSetup } from './seed.mjs'
import { connectStack } from './stack.mjs'

export function resolveOptions(values) {
  const options = args(values, ['device', 'port', 'appium-port', 'manager', 'scenario', 'scenarios', 'output', 'rebuild', 'native', 'stack-dir', 'help'])
  if (options.help) return { help: true }
  assert.ok(typeof options.device === 'string' && options.device.trim(), '--device is required')
  const port = Number(options.port), appiumPort = Number(options['appium-port'] ?? 40000 + (port % 5000) * 4), manager = Number(options.manager ?? 0)
  assert.ok(Number.isInteger(port) && port > 1024 && port < 64000, '--port must be between 1025 and 63999')
  assert.ok(Number.isInteger(appiumPort) && appiumPort > 1024 && appiumPort < 65532 && ![appiumPort, appiumPort + 1, appiumPort + 2].includes(port), 'Choose distinct valid web and Appium ports')
  assert.ok(Number.isInteger(manager) && manager >= 0 && manager < 10, '--manager must be 0 through 9')
  const output = path.resolve(options.output ?? path.join(home, 'runs', `${new Date().toISOString().replaceAll(':', '-')}-${options.device.replace(/[^a-zA-Z0-9-]/g, '-')}`))
  assert.ok(!output.startsWith(`${repo}/`) && output !== repo, 'Reports must stay outside the checkout')
  return { ...options, device: options.device, port, appiumPort, manager, scenario: options.scenario ?? 'all', output }
}

function substitute(value, context) {
  if (Array.isArray(value)) return value.map(item => substitute(item, context))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, context)]))
  if (typeof value !== 'string') return value
  return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const result = key.split('.').reduce((object, part) => object?.[part], context)
    assert.ok(result !== undefined, `Unknown scenario fixture ${key}`)
    return String(result)
  })
}

export function expandScenarios(scenarios) {
  const names = new Set()
  const expanded = scenarios.flatMap(scenario => {
    assert.ok(!names.has(scenario.name), `Duplicate scenario ${scenario.name}`)
    names.add(scenario.name)
    const { repeat = 1, ...template } = scenario
    assert.ok(Number.isInteger(repeat) && repeat > 0, `Invalid repeat for ${scenario.name}`)
    return Array.from({ length: repeat }, (_, index) => ({ ...template, name: repeat === 1 ? template.name : `${template.name}-repeat-${index + 1}` }))
  })
  names.clear()
  for (const scenario of expanded) {
    assert.ok(!names.has(scenario.name), `Duplicate scenario ${scenario.name}`)
    names.add(scenario.name)
  }
  return expanded
}

async function waitFor(check, timeout = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (await check()) return; await pause(200) }
  throw new Error('The expected page did not become ready')
}

export function requireContent(step) {
  const reasons = failures(step).filter(reason => reason !== 'The screen did not settle within the observation window')
  assert.equal(reasons.length, 0, reasons.join('; '))
}

export async function visibleTapLabel(driver, label, prefix = false) {
  let target
  await waitFor(async () => {
    target = await driver.execute(`const label = arguments[0], prefix = arguments[1]; const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); const match = [...document.querySelectorAll('[aria-label],button,a,[role="button"],select')].find(e => visible(e) && (prefix ? (e.getAttribute('aria-label') || '').startsWith(label) : e.getAttribute('aria-label') === label || e.textContent?.trim() === label)); if (match) match.scrollIntoView({block:'nearest'}); return match ? match.getAttribute('aria-label') || label : null`, label, prefix)
    return target !== null
  })
  return target
}

export async function clickThroughPasswordPrompt(driver, label) {
  try { return await driver.click(label) }
  catch (error) {
    const source = await driver.request('GET', '/source')
    if (!source.includes('name="Save Password?"')) throw error
    await driver.click('Never for This Website')
    return driver.click(label)
  }
}

export async function selectNativeOption(driver, label) {
  await driver.native()
  await clickThroughPasswordPrompt(driver, label)
  await driver.optional('Done')
}

export async function waitForNativeTransition(driver) {
  await driver.native()
  const settings = await driver.request('GET', '/appium/settings')
  try {
    await driver.request('POST', '/appium/settings', { settings: { waitForIdleTimeout: 5 } })
    await driver.request('GET', '/source')
  } finally {
    await driver.request('POST', '/appium/settings', { settings: { waitForIdleTimeout: settings.waitForIdleTimeout } })
  }
}

export async function refreshInstalledPage(driver, origin) {
  await driver.web(origin, true)
  const previous = await driver.execute(`const target = arguments[0], previous = performance.timeOrigin;
    void (async () => {
      localStorage.clear(); sessionStorage.clear();
      const registrations = await navigator.serviceWorker?.getRegistrations() ?? [];
      await Promise.all(registrations.map(registration => registration.unregister()));
      if (typeof caches !== 'undefined') await Promise.all((await caches.keys()).filter(name => name.startsWith('pancake-')).map(name => caches.delete(name)));
      location.replace(target);
    })();
    return previous`, `${origin}/sign-in`)
  await waitFor(async () => {
    await driver.web(origin, true)
    return driver.execute('return performance.timeOrigin !== arguments[0] && document.readyState === "complete"', previous)
  })
}

export async function prepareScenarioPage(server, driver, origin, route, web, theme = undefined) {
  server.network(false)
  let previousDocument
  if (web) {
    await driver.web(origin, true)
    previousDocument = await driver.execute('return performance.timeOrigin')
  }
  server.prepare(`${origin}${route}`, theme)
  if (web) {
    await driver.web(origin, true)
    await waitFor(async () => driver.execute('const target = new URL(arguments[0], location.href); return performance.timeOrigin !== arguments[1] && location.pathname === target.pathname && location.search === target.search && document.readyState === "complete" && (document.getElementById("root")?.innerText.trim().length || 0) > 20', route, previousDocument))
  } else await pause(2500)
}

export async function requireStackHealthy(stack, origin, fetchImpl = fetch) {
  const targets = [
    ['frontend', `${origin}/release-provenance.json`],
    ['auth', `${stack.url}/auth/v1/health`],
    ['Edge', `${stack.url}/functions/v1/api/health`],
  ]
  await Promise.all(targets.map(async ([label, url]) => {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000), cache: 'no-store' })
      assert.ok(response.ok, `HTTP ${response.status}`)
    } catch (error) { throw new Error(`stack not healthy: ${label} (${error.message})`) }
  }))
}

async function playerTradeContext(stack, playerId) {
  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(stack.url, stack.serviceKey, { auth: { persistSession: false } })
  const { data, error } = await admin.from('roster_players').select('member_id')
    .eq('league_id', stack.fixture.leagueId).eq('league_season_id', stack.fixture.seasonId).eq('player_id', playerId).single()
  if (error) throw new Error(`Trade capture owner lookup: ${error.message}`)
  const owner = stack.fixture.members.find(member => member.id === data.member_id)
  assert.ok(owner, 'Trade capture player has no seeded owner')
  return { player: stack.fixture.players.find(player => player.id === playerId), teamName: owner.team_name }
}

async function runSuite(options) {
  const report = { head: await run('git', ['rev-parse', 'HEAD']), startedAt: new Date().toISOString(), steps: [], options: { ...options, output: undefined } }
  let server, driver, device, recording, log, web = false
  await mkdir(options.output, { recursive: true })
  let interrupted = false
  const signals = () => { interrupted = true }
  process.once('SIGINT', signals)
  process.once('SIGTERM', signals)
  try {
    await freePort(options.port)
    const stack = await connectStack(options['stack-dir'])
    const build = await exportWeb(stack, options.rebuild === true)
    report.build = build.hash
    report.sourceFingerprint = build.sourceFingerprint
    server = await serve({ root: build.root, port: options.port })
    const origin = `http://127.0.0.1:${options.port}`
    await verifyBuild(origin, build)
    await requireStackHealthy(stack, origin)
    device = await simulator(options.device)
    report.device = device
    driver = await startDriver({ device, port: options.appiumPort, directory: options.output })
    log = await open(path.join(options.output, 'video.log'), 'a')
    recording = spawn('/usr/bin/xcrun', ['simctl', 'io', device.udid, 'recordVideo', '--codec=h264', '--force', path.join(options.output, 'video.mp4')], { stdio: ['ignore', log.fd, log.fd] })
    report.videoStartedAt = Date.now()
    web = await installPwa(driver, { device, origin, title: `Pancake ${options.port}`, directory: options.output })
    await requireStackHealthy(stack, origin)
    if (options.native === true) web = false
    report.webviewReachable = web
    const withWeb = async action => {
      if (!web) return null
      await driver.web(origin, true)
      return action()
    }
    const tap = async (label, prefix = false) => {
      const actual = await withWeb(() => visibleTapLabel(driver, label, prefix))
      await driver.native()
      if (prefix && !actual) await driver.click(`label BEGINSWITH ${JSON.stringify(label)} AND visible == true AND enabled == true`, '-ios predicate string')
      else {
        try { await clickThroughPasswordPrompt(driver, actual ?? label) } catch (error) {
          if (web) throw error
          await driver.mobile('scroll', { predicateString: `label == ${JSON.stringify(label)}`, toVisible: true })
          await driver.click(label)
        }
      }
    }
    const fill = async (label, value) => {
      await tap(label)
      const id = await driver.find(label)
      await driver.request('POST', `/element/${id}/clear`, {})
      await driver.request('POST', `/element/${id}/value`, { text: value })
      await driver.optional('Done')
      server.blur()
      await pause(500)
    }
    const prepare = (route, theme) => prepareScenarioPage(server, driver, origin, route, web, theme)
    if (web) await refreshInstalledPage(driver, origin)
    await waitFor(() => server.connected() > 0)
    server.resetAuth(`${origin}/sign-in`)
    await waitFor(() => server.verified() > 0)
    report.installedSourceFingerprint = build.sourceFingerprint
    await pause(1000)
    const user = stack.fixture.users[options.manager]
    await fill('Email', user.email)
    await fill('Password', stack.fixture.password)
    server.arm({ id: 'sign-in', expected: { text: user.teamName }, immediate: !web })
    await server.armed('sign-in')
    await tap('Sign In')
    const signedIn = await server.result('sign-in', 20000)
    await driver.native()
    if (!await driver.optional('Never for This Website')) await driver.optional('Not Now')
    report.steps.push({ id: 'sign-in', metrics: signedIn })
    await driver.screenshot(path.join(options.output, 'sign-in.png'))
    await writeReport(options.output, report)
    requireContent(report.steps[0])
    const index = options.manager * 22
    const offset = stack.fixture.players.slice(index, index + 10).findIndex(player => !['DEN', 'LAL'].includes(player.nba_team))
    const tradeTarget = await playerTradeContext(stack, stack.fixture.players[66].id)
    const context = { tradeTarget, liveFreeAgent: stack.fixture.players[222], weekOffLeagueName: `Home week-off ${stack.fixture.members[options.manager].id.slice(0, 8)}`, rosterPlanTradeId: stack.fixture.rosterPlanTrade.id, memberId: stack.fixture.members[options.manager].id, displayName: user.displayName, teamName: user.teamName, otherTeam: stack.fixture.users[options.manager ^ 1].teamName, otherMemberId: stack.fixture.members[options.manager ^ 1].id, liveAuctionId: stack.fixture.drafts.find(draft => draft.draft_type === 'auction').id, lineupSlot: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'UTIL', 'F', 'UTIL', 'UTIL'][offset], rosterPlayer: stack.fixture.players[index + offset], benchPlayer: stack.fixture.players[index + offset + 10], freeAgent: stack.fixture.players[220 + options.manager], waiverPlayer: stack.fixture.players[230 + options.manager], outPlayer: stack.fixture.players[240 + options.manager] }
    const scenarios = JSON.parse(await readFile(options.scenarios ?? new URL('./scenarios.json', import.meta.url), 'utf8'))
    const selected = expandScenarios(scenarios.filter(scenario => options.scenario === 'all' || scenario.name === options.scenario || scenario.group === options.scenario))
    assert.ok(selected.length, `Unknown scenario ${options.scenario}`)
    const action = async spec => {
      if (spec.sequence) { for (const item of spec.sequence) await action(item); return }
      if (spec.scrollEnd) {
        assert.ok(web, 'End scroll captures require the app webview')
        return withWeb(() => driver.execute(`for (const element of document.querySelectorAll('body *')) if (element.scrollHeight > element.clientHeight + 50 && element.clientHeight > 200 && ['auto','scroll'].includes(getComputedStyle(element).overflowY)) element.scrollTop = element.scrollHeight; window.scrollTo(0, document.body.scrollHeight)`))
      }
      if (spec.revealText) {
        assert.ok(web, 'Text scroll captures require the app webview')
        return withWeb(() => waitFor(async () => driver.execute(`const target = [...document.querySelectorAll('h1,h2,h3,[role=heading],div,span')].find(element => element.textContent?.trim() === arguments[0] && element.getClientRects().length); if (!target) return false; target.scrollIntoView({block:'start'}); return true`, spec.revealText)))
      }
      if (spec.reveal) {
        if (web) return withWeb(() => visibleTapLabel(driver, spec.reveal))
        await driver.native()
        return driver.mobile('scroll', { predicateString: `label == ${JSON.stringify(spec.reveal)}`, toVisible: true })
      }
      if (spec.tap) return tap(spec.tap)
      if (spec.tapPrefix) return tap(spec.tapPrefix, true)
      if (spec.fill) { await fill(spec.fill, spec.value); await pause(800); return }
      if (spec.open) { server.navigate(`${origin}${spec.open}`); return }
      if (spec.select) { await tap(spec.select); await selectNativeOption(driver, spec.option); return }
      if (spec.offline) { server.network(true); return }
      if (spec.background) {
        await driver.native()
        await driver.mobile('pressButton', { name: 'home' })
        await pause(2000)
        let launched = false
        for (let page = 0; page < 4; page++) {
          if (await driver.optional(`Pancake ${options.port}`)) { launched = true; break }
          await driver.mobile('swipe', { direction: 'left' })
        }
        assert.ok(launched, 'Could not return through the Home Screen icon')
        await waitForNativeTransition(driver)
        return
      }
      throw new Error('Unknown scenario action')
    }
    await withScenarioFixtures(stack, selected, async drafts => {
      for (const template of selected) {
        const scenario = substitute(template, { ...context, draftId: drafts[template.setup?.draftRoom] })
        if (interrupted) throw new Error('Run interrupted')
        await requireStackHealthy(stack, origin)
        process.stdout.write(`Checking ${scenario.name}.\n`)
        try {
          await withScenarioSetup(stack, scenario.setup, async () => {
            server.disarm()
            await prepare(scenario.from, scenario.theme)
            for (const spec of scenario.prepare ?? []) { await action(spec); await pause(600) }
            for (const [stepIndex, step] of scenario.steps.entries()) {
              const id = `${scenario.name}${stepIndex ? `-${step.name ?? stepIndex + 1}` : ''}`
              const result = { id, note: step.note, videoOffsetMs: Date.now() - report.videoStartedAt }
              try {
                server.arm({ id, expected: step.expected, quietMs: step.quietMs, allowClock: step.allowClock === true, requireWorker: Boolean(step.action.background || step.action.offline), immediate: !web || Boolean(step.action.open || step.action.reveal || step.action.revealText || step.action.scrollEnd || step.action.background || step.action.offline) })
                await server.armed(id)
                await action(step.action)
                result.metrics = await server.result(id)

              } catch (error) { result.error = error.message }
              await driver.native()
              await driver.screenshot(path.join(options.output, `${id}.png`))
              await driver.source(path.join(options.output, `${id}.xml`))
              report.steps.push(result)
              server.disarm()
              await writeReport(options.output, report)
            }
          })
        } catch (error) {
          report.steps.push({ id: scenario.name, error: error.message })
          await driver.native().catch(() => {})
          await driver.screenshot(path.join(options.output, `${scenario.name}.png`)).catch(() => {})
          await driver.source(path.join(options.output, `${scenario.name}.xml`)).catch(() => {})
        }
      }
    })
  } catch (error) { report.error = error.message }
  finally {
    if (server) { server.network(false); server.disarm() }
    await stopChild(recording, 'SIGINT')
    if (recording && !(await stat(path.join(options.output, 'video.mp4')).catch(() => null))?.size) report.error ??= 'Simulator video recording is missing or empty'
    await log?.close()
    if (driver) await driver.close().catch(error => { report.cleanupError = error.message })
    if (device) await run('xcrun', ['simctl', 'shutdown', device.udid]).catch(error => { report.cleanupError = error.message })
    if (server) await server.close()
    if (recording && !web) {
      report.videoDifferences = await videoDifferences(path.join(options.output, 'video.mp4'), options.output).catch(error => ({ error: error.message }))
      if (Array.isArray(report.videoDifferences)) for (const step of report.steps) {
        if (!step.metrics || step.metrics.firstContentMs === null) continue
        const start = step.metrics.startedAt - report.videoStartedAt + step.metrics.firstContentMs
        const end = step.metrics.startedAt - report.videoStartedAt + step.metrics.durationMs
        step.videoDifferences = report.videoDifferences.filter(event => event.timeMs >= start && event.timeMs <= end)
      }
    }
    report.finishedAt = new Date().toISOString()
    await writeReport(options.output, report)
    process.removeListener('SIGINT', signals)
    process.removeListener('SIGTERM', signals)
  }
  process.stdout.write(`Report: ${path.join(options.output, 'report.md')}\n${report.passed} passed; ${report.failed} failed.\n`)
  if (report.failed || report.error || report.cleanupError) process.exitCode = 1
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = resolveOptions(process.argv.slice(2))
    if (!('manager' in options)) process.stdout.write('Usage: node scripts/ios-sim/run.mjs --device NAME --port PORT [--manager 0..9] [--scenario all|tabs|interactions|lifecycle|NAME] [--scenarios JSON] [--output PATH] [--appium-port PORT] [--rebuild] [--native]\n')
    else {
      const ports = [options.port, options.appiumPort, options.appiumPort + 1, options.appiumPort + 2].sort((a, b) => a - b)
      const reserve = index => index === ports.length ? runSuite(options) : lock(path.join(home, `ports/${ports[index]}.lock`), () => reserve(index + 1))
      lock(path.join(home, `device-${digest(options.device)}.lock`), () => lock(path.join(home, `manager-${options.manager}.lock`), () => reserve(0))).catch(error => { console.error(error); process.exitCode = 1 })
    }
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}

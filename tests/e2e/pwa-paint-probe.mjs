import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv } from './env.mjs'
import { captureBrowserScreenshot, createBrowser, fillSignInCredentials, openCdpClient, selectCdpPageTarget } from './browser-agent.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

// Diagnostic probe for the missing `first-contentful-paint` entry (release soak
// attempt 2, season 3, 2026-09-13: shell mark 6.8 ms and app mount 29.8 ms were
// recorded and the screenshot showed the app, yet `performance.getEntriesByType
// ('paint')` was empty on a visible, focused document with paint timing
// supported). It launches the built app N times, alternating a FRESH browser
// session (every session closed first) with a REUSED session, and records for
// each launch what the engine reports through two independent readers:
//   1. performance.getEntriesByType('paint')            (what the gate reads)
//   2. new PerformanceObserver(...).observe({ type: 'paint', buffered: true })
// plus the boot marks, visibility, focus, readiness, navigation type, and the
// engine's user agent. Every launch is kept; nothing is filtered or retried.
//
// EARLY READER (capability-tested per session): agent-browser 0.25 has no
// init-script flag, but it exposes the page's CDP endpoint (`get cdp-url`,
// already used by the screenshot and smoke paths). Before each measured
// navigation the probe attaches to the page target and registers a
// PerformanceObserver through Page.addScriptToEvaluateOnNewDocument, so it
// runs at document start and stores every paint entry on
// window.__pancakePaintProbe. Whether that registration succeeded is recorded
// per launch; when it did not, both remaining readers are late and an empty
// result is 'no-late-reader-evidence', never proof the engine produced none.
//
// Session ownership: the probe touches only sessions it names itself. Fresh
// launches get a new session each and are closed individually; the single
// reused session lives across every reused launch and is closed at the end.
// Nothing else on the host is closed.
// The gate is the product gate: FCP present AND <= launchShellPaintMs passes;
// a missing entry is a failure ("unknown"), never a pass; an absent entry says
// nothing about app speed. Exit status is 1 if any launch fails.
//
// Usage (after `npm run e2e:seed`, with the release build served on the
// frontend URL, see tests/e2e/README.md):
//   node tests/e2e/pwa-paint-probe.mjs [--launches=20] [--path=/roster] [--wait-ms=3000] [--signed-out]
// (no global session close is performed; the probe owns and closes only its own sessions)

const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const DEFAULT_ARTIFACT_DIR = path.join(ROOT, 'tests/artifacts/pwa-paint-probe')
const BUDGETS = JSON.parse(readFileSync(path.join(ROOT, 'tests/e2e/performance-budgets.json'), 'utf8')).globalBudgets
const COMMAND_TIMEOUT_MS = Number(process.env.E2E_PWA_LAUNCH_TIMEOUT_MS ?? 90_000)
const execFileAsync = promisify(execFile)

const arg = (name, fallback) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`))
  return match ? match.slice(name.length + 3) : fallback
}
export const parseCount = (value, label = 'launches') => {
  const count = Number(value)
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1) throw new RangeError(`${label} must be a finite positive integer (got ${String(value)})`)
  return count
}
export const parseWaitMs = (value) => {
  const wait = Number(value)
  if (!Number.isFinite(wait) || wait < 0) throw new RangeError(`wait-ms must be a finite number >= 0 (got ${String(value)})`)
  return wait
}

const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()
const parseEvalJson = (output) => {
  const start = output.indexOf('{')
  if (start < 0) throw new Error(`eval returned no JSON: ${output.slice(0, 200)}`)
  return JSON.parse(output.slice(start, output.lastIndexOf('}') + 1))
}
// Runs at document start when Page.addScriptToEvaluateOnNewDocument is
// available: records paint entries as the engine emits them.
const EARLY_OBSERVER_SCRIPT = `(() => {
  const store = { installedAt: performance.now(), entries: [], error: null };
  window.__pancakePaintProbe = store;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.entries.push({ name: entry.name, startTime: entry.startTime });
    });
    observer.observe({ type: 'paint', buffered: true });
  } catch (error) {
    store.error = String(error);
  }
})()`

// Everything the diagnosis needs, read in one round trip.
const PAINT_STATE = `(async () => {
  const early = window.__pancakePaintProbe ? { installedAt: window.__pancakePaintProbe.installedAt, entries: window.__pancakePaintProbe.entries.slice(), error: window.__pancakePaintProbe.error } : null;
  const byType = performance.getEntriesByType('paint').map((entry) => ({ name: entry.name, startTime: entry.startTime }));
  const observed = await new Promise((resolve) => {
    let done = false;
    const finish = (entries) => { if (!done) { done = true; resolve(entries); } };
    try {
      const observer = new PerformanceObserver((list) => {
        finish(list.getEntries().map((entry) => ({ name: entry.name, startTime: entry.startTime })));
        observer.disconnect();
      });
      observer.observe({ type: 'paint', buffered: true });
      setTimeout(() => { observer.disconnect(); finish([]); }, 1000);
    } catch (error) {
      finish([{ name: 'observer-error', startTime: -1, error: String(error) }]);
    }
  });
  const mark = (name) => performance.getEntriesByName(name)[0]?.startTime ?? null;
  const nav = performance.getEntriesByType('navigation')[0] || null;
  return JSON.stringify({
    path: location.pathname,
    fcpByType: byType.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null,
    paintByType: byType,
    paintObserved: observed,
    paintEarly: early,
    shellMark: mark('pancake-boot-shell'),
    mountMark: mark('pancake-app-mounted'),
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    readyState: document.readyState,
    prerendering: document.prerendering === true,
    navigationType: nav ? nav.type : null,
    navigationDuration: nav ? nav.duration : null,
    paintTimingSupported: (PerformanceObserver.supportedEntryTypes || []).includes('paint'),
    userAgent: navigator.userAgent,
    swControlled: !!navigator.serviceWorker?.controller,
    rootTextLength: (document.getElementById('root')?.innerText || '').length,
  });
})()`

// Close exactly one probe-owned session; never anything else on the host.
const closeOwnedSession = async (browser, session) => {
  await browser(session, ['close']).catch(() => {})
}

// Register the early observer for the session's page target. Returns what
// happened so the record can say whether an early reader existed.
export const installEarlyObserver = async (browser, session, { openClient = openCdpClient } = {}) => {
  try {
    const output = await browser(session, ['get', 'cdp-url'])
    const endpoint = output.match(/ws:\/\/\S+/)?.[0]
    if (!endpoint) return { installed: false, error: 'no CDP endpoint from agent-browser' }
    const client = await openClient(endpoint)
    try {
      const { targetInfos } = await client.send('Target.getTargets')
      const page = selectCdpPageTarget(targetInfos)
      if (!page) return { installed: false, error: 'no page target' }
      const { sessionId } = await client.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
      await client.send('Page.enable', {}, sessionId)
      const result = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: EARLY_OBSERVER_SCRIPT }, sessionId)
      return { installed: true, identifier: result.identifier ?? null, endpointHost: new URL(endpoint).hostname }
    } finally {
      client.close()
    }
  } catch (error) {
    return { installed: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Setup navigation (sign-in page): may retry, and every attempt is counted so
// the record shows it. Never used for the measured launch.
const openSetupPage = async (browser, session, url) => {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await browser(session, ['open', url], { timeout: COMMAND_TIMEOUT_MS })
      return attempt
    } catch (error) {
      lastError = error
      await browser(session, ['wait', '1000']).catch(() => {})
    }
  }
  throw new Error(`setup navigation failed after 3 attempts: ${lastError instanceof Error ? lastError.message : 'unknown error'}`)
}

// Measured navigation: exactly one attempt. A failure is a recorded result.
const openMeasuredPage = async (browser, session, url) => {
  await browser(session, ['open', url], { timeout: COMMAND_TIMEOUT_MS })
}

const signIn = async (browser, evaluate, session, frontendUrl, email, password) => {
  const setupAttempts = await openSetupPage(browser, session, joinUrl(frontendUrl, '/sign-in'))
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await fillSignInCredentials(browser, session, email, password); break } catch { await browser(session, ['wait', '1000']).catch(() => {}) }
  }
  await browser(session, ['click', 'text=Sign In']).catch(async () => {
    await browser(session, ['eval', `(() => {
      const target = [...document.querySelectorAll('[role="button"], button, [tabindex]')]
        .find((element) => /^\\s*sign in\\s*$/i.test((element.textContent || '').trim()));
      target?.click();
      return JSON.stringify({ clicked: !!target });
    })()`])
  })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await evaluate(session, `(() => JSON.stringify({ path: location.pathname, text: (document.getElementById('root')?.innerText || '').length }))()`)
    if (state.path === '/' && state.text > 0) return { setupAttempts }
    await browser(session, ['wait', '1000']).catch(() => {})
  }
  throw new Error('sign-in did not reach the app')
}

// Sample allocation: launches alternate FRESH (odd-numbered) and REUSED
// (even-numbered) so the two conditions are interleaved in time rather than
// blocked, and any drift on the host affects both equally.
export const allocateLaunches = (count) => Array.from({ length: parseCount(count) }, (_, index) => ({
  index: index + 1,
  mode: index % 2 === 0 ? 'fresh' : 'reused',
}))

// The product gate. A timing that is not a finite number >= 0 is treated as
// missing: undefined, NaN, Infinity or a negative value can never pass.
export const judgeLaunch = (state, budgetMs) => {
  const fcp = state?.fcpByType
  const observed = Array.isArray(state?.paintObserved) && state.paintObserved.some((entry) => entry?.name === 'first-contentful-paint')
  const earlyEntries = Array.isArray(state?.paintEarly?.entries) ? state.paintEarly.entries : null
  const early = earlyEntries ? earlyEntries.some((entry) => entry?.name === 'first-contentful-paint') : null
  if (typeof fcp !== 'number' || !Number.isFinite(fcp) || fcp < 0) {
    if (early === true) return { status: 'FAIL', reason: 'missing-timing: no first-contentful-paint via getEntriesByType (early observer saw it: entry produced, then not exposed to the gate reader)' }
    if (early === false) return { status: 'FAIL', reason: 'missing-timing: no first-contentful-paint anywhere, early observer installed and saw none (engine emitted no paint entry for this document)' }
    return {
      status: 'FAIL',
      reason: observed
        ? 'missing-timing: no first-contentful-paint entry via getEntriesByType (present via late buffered observer)'
        : 'missing-timing: no-late-reader-evidence (no early observer; neither late reader saw first-contentful-paint; engine output not established)',
    }
  }
  if (fcp > budgetMs) return { status: 'FAIL', reason: `budget: fcp ${Math.round(fcp)}ms > ${budgetMs}ms` }
  return { status: 'PASS', reason: `fcp ${Math.round(fcp)}ms <= ${budgetMs}ms` }
}

/**
 * @param {{ browserFactory?: () => import('./browser-agent.mjs').Browser, launches?: number, waitMs?: number, route?: string, signedOut?: boolean, env?: any, readState?: () => Promise<any>, artifactDir?: string, earlyObserver?: typeof installEarlyObserver, log?: (line: string) => void }} [options]
 */
export const runPaintProbe = async (options = {}) => {
  const browser = (options.browserFactory ?? (() => createBrowser({ cwd: ROOT, defaultTimeout: COMMAND_TIMEOUT_MS })))()
  const evaluate = async (session, expression) => parseEvalJson(await browser(session, ['eval', expression]))
  const earlyObserver = options.earlyObserver ?? installEarlyObserver
  const log = options.log ?? console.log
  const ROUTE = options.route ?? arg('path', '/roster')
  const SIGNED_OUT = options.signedOut ?? process.argv.includes('--signed-out')
  const ARTIFACT_DIR = options.artifactDir ?? DEFAULT_ARTIFACT_DIR
  const LAUNCHES = parseCount(options.launches ?? arg('launches', 20))
  const WAIT_MS = parseWaitMs(options.waitMs ?? arg('wait-ms', 3000))
  const env = options.env ?? resolvedEnv()
  const frontendUrl = env.frontendUrl
  const isLocal = (url) => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname)
  if (!isLocal(frontendUrl)) throw new Error(`probe only runs against a local frontend (got ${new URL(frontendUrl).hostname})`)
  if (!SIGNED_OUT && (!env.supabaseUrl || !isLocal(env.supabaseUrl))) throw new Error(`probe only signs in against a local Supabase endpoint (got ${env.supabaseUrl ? new URL(env.supabaseUrl).hostname : 'none'})`)
  await mkdir(ARTIFACT_DIR, { recursive: true })

  let user = null
  let password = null
  if (!SIGNED_OUT) {
    const state = options.readState ? await options.readState() : JSON.parse(await readFile(STATE_PATH, 'utf8'))
    user = state.users[0]
    password = state.password
    if (!env.supabaseUrl || !env.anonKey) throw new Error('supabaseUrl and anonKey are required for a signed-in probe')
    const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
    const { error } = await client.auth.signInWithPassword({ email: user.email, password })
    if (error) throw new Error(`seeded user cannot sign in: ${error.message}`)
  }

  const launches = allocateLaunches(LAUNCHES)
  /** @type {Array<Record<string, any>>} */
  const results = []
  const reusedSession = `pwa-paint-probe-reused-${process.pid}`
  let reusedSignedIn = false
  const startedAt = new Date().toISOString()

  for (const launch of launches) {
    const session = launch.mode === 'fresh' ? `pwa-paint-probe-fresh-${process.pid}-${launch.index}` : reusedSession
    /** @type {Record<string, any>} */
    const record = { ...launch, session, startedAt: new Date().toISOString(), url: joinUrl(frontendUrl, ROUTE), setupAttempts: 0, measuredNavigationAttempts: 0 }
    try {
      // Setup (may retry, counted): a fresh session signs in every time; the
      // reused session signs in once and is then kept alive across launches.
      if (!SIGNED_OUT && (launch.mode === 'fresh' || !reusedSignedIn)) {
        const setup = await signIn(browser, evaluate, session, frontendUrl, user.email, password)
        record.setupAttempts = setup.setupAttempts
        if (launch.mode === 'reused') reusedSignedIn = true
      }
      // Early reader, registered before the measured navigation when CDP allows it.
      record.earlyObserver = await earlyObserver(browser, session)
      // Measured navigation: one attempt, whatever happens is the result.
      record.measuredNavigationAttempts = 1
      await openMeasuredPage(browser, session, record.url)
      await browser(session, ['wait', String(WAIT_MS)])
      const state = await evaluate(session, PAINT_STATE)
      const shot = `launch-${String(launch.index).padStart(2, '0')}-${launch.mode}.png`
      await captureBrowserScreenshot(browser, session, ARTIFACT_DIR, shot).catch(() => {})
      Object.assign(record, { state, screenshot: shot, ...judgeLaunch(state, BUDGETS.launchShellPaintMs) })
    } catch (error) {
      Object.assign(record, { status: 'FAIL', reason: `probe error: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      if (launch.mode === 'fresh') await closeOwnedSession(browser, session)
    }
    record.finishedAt = new Date().toISOString()
    results.push(record)
    log(`launch ${String(launch.index).padStart(2)} ${launch.mode.padEnd(6)} ${record.status} ${record.reason}` +
      (record.state ? ` | early=${record.earlyObserver?.installed ? (record.state.paintEarly?.entries?.length ?? 'n/a') : 'off'} byType=${record.state.paintByType.length} observed=${record.state.paintObserved.length} shell=${record.state.shellMark?.toFixed?.(1)} mount=${record.state.mountMark?.toFixed?.(1)} vis=${record.state.visibilityState} focus=${record.state.hasFocus}` : ''))
  }
  await closeOwnedSession(browser, reusedSession)

  const summary = {
    fresh: { total: results.filter((r) => r.mode === 'fresh').length, pass: results.filter((r) => r.mode === 'fresh' && r.status === 'PASS').length },
    reused: { total: results.filter((r) => r.mode === 'reused').length, pass: results.filter((r) => r.mode === 'reused' && r.status === 'PASS').length },
    earlyObserverInstalled: results.filter((r) => r.earlyObserver?.installed).length,
    missingByTypeButEarlySaw: results.filter((r) => r.state && r.state.fcpByType === null && r.state.paintEarly?.entries?.some((e) => e.name === 'first-contentful-paint')).length,
    missingEverywhereWithEarly: results.filter((r) => r.state && r.earlyObserver?.installed && r.state.fcpByType === null && r.state.paintEarly && !r.state.paintEarly.entries.some((e) => e.name === 'first-contentful-paint')).length,
    missingByTypeButObserved: results.filter((r) => r.state && r.state.fcpByType === null && r.state.paintObserved.some((e) => e.name === 'first-contentful-paint')).length,
    noLateReaderEvidence: results.filter((r) => r.state && !r.earlyObserver?.installed && r.state.fcpByType === null && !r.state.paintObserved.some((e) => e.name === 'first-contentful-paint')).length,
    probeErrors: results.filter((r) => !r.state).length,
    readerLimit: 'the late readers run after the measured navigation; without an installed early observer an empty result cannot distinguish an evicted or unbuffered entry from one the engine never produced',
  }
  const report = {
    startedAt, finishedAt: new Date().toISOString(), frontendUrl, route: ROUTE, waitMs: WAIT_MS, signedIn: !SIGNED_OUT,
    budgetMs: BUDGETS.launchShellPaintMs, allocation: `${LAUNCHES} launches, alternating fresh (own session, closed after) / reused (one session kept across all reused launches)`,
    agentBrowserVersion: (await execFileAsync('agent-browser', ['--version'], { cwd: ROOT }).then((r) => r.stdout.trim()).catch(() => 'unknown')),
    userAgent: results.find((r) => r.state)?.state.userAgent ?? null,
    summary, results,
  }
  await writeFile(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    '# PWA paint probe', '', `- Started: ${report.startedAt}`, `- Frontend: ${frontendUrl} route ${ROUTE}`, `- Allocation: ${report.allocation}`,
    `- Gate: FCP present and <= ${report.budgetMs} ms; a missing entry is a failure and says nothing about speed`, `- agent-browser: ${report.agentBrowserVersion}`, `- User agent: ${report.userAgent ?? 'n/a'}`, '',
    `Fresh: ${summary.fresh.pass}/${summary.fresh.total} pass. Reused: ${summary.reused.pass}/${summary.reused.total} pass. Early observer installed on ${summary.earlyObserverInstalled} launches. Missing by getEntriesByType but seen by the early observer: ${summary.missingByTypeButEarlySaw}. Missing everywhere with the early observer installed: ${summary.missingEverywhereWithEarly}. Missing by getEntriesByType but present via late buffered observer: ${summary.missingByTypeButObserved}. No late-reader evidence (no early observer): ${summary.noLateReaderEvidence}. Probe errors: ${summary.probeErrors}.`, '',
    `Reader limit: ${summary.readerLimit}.`, '',
    '| # | mode | status | reason | setup attempts | measured nav attempts | early observer | paint (early) | paint (byType) | paint (late observer) | shell ms | mount ms | visible | focus | nav |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.index} | ${r.mode} | ${r.status} | ${r.reason} | ${r.setupAttempts} | ${r.measuredNavigationAttempts} | ${r.earlyObserver ? (r.earlyObserver.installed ? 'installed' : `not installed: ${r.earlyObserver.error}`) : '-'} | ${r.state?.paintEarly ? r.state.paintEarly.entries.map((e) => `${e.name}@${Math.round(e.startTime)}`).join(' ') || 'none' : '-'} | ${r.state ? r.state.paintByType.map((e) => `${e.name}@${Math.round(e.startTime)}`).join(' ') || 'none' : '-'} | ${r.state ? r.state.paintObserved.map((e) => `${e.name}@${Math.round(e.startTime)}`).join(' ') || 'none' : '-'} | ${r.state?.shellMark?.toFixed?.(1) ?? '-'} | ${r.state?.mountMark?.toFixed?.(1) ?? '-'} | ${r.state?.visibilityState ?? '-'} | ${r.state?.hasFocus ?? '-'} | ${r.state?.navigationType ?? '-'} |`),
  ]
  await writeFile(path.join(ARTIFACT_DIR, 'report.md'), `${lines.join('\n')}\n`)
  const failed = results.filter((r) => r.status !== 'PASS').length
  log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} launches recorded a first-contentful-paint within budget; report at ${path.relative(ROOT, ARTIFACT_DIR)}/report.md`)
  return { failed, results, report }
}

// Entry point: every browser session the probe touches is owned by a scenario
// resource owner, exactly like the launch gate (phase-8 run 1 failed with
// 'Cannot own browser session ... without an active scenario resource owner').
export const runPaintProbeEntry = (options = {}) =>
  runWithScenarioResourceOwner('pwa-paint-probe', () => runPaintProbe(options))

if (import.meta.url === `file://${process.argv[1]}`) {
  runPaintProbeEntry()
    .then(({ failed }) => { process.exitCode = failed === 0 ? 0 : 1 })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

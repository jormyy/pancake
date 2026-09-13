import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
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
// supported). It repeats the launch gate's own sequence N times, alternating a
// FRESH probe-owned session (full gate prelude, closed after its launch) with
// one REUSED probe-owned session (prelude once, then measured relaunches), and
// records for each launch what three readers report:
//   1. an EARLY observer registered through the browser's CDP endpoint with
//      Page.addScriptToEvaluateOnNewDocument before the measured navigation,
//      kept attached until after the read (the script is removed and the
//      CDP client closed afterwards) — "ran" only when the page exposed it;
//   2. performance.getEntriesByType('paint')             (what the gate reads);
//   3. a LATE buffered PerformanceObserver evaluated after the load.
// Plus the boot marks, visibility, focus, readiness, navigation type and user
// agent, and one screenshot. Sign-in setup may retry and every attempt is
// counted; the measured navigation is exactly one attempt. Every launch is
// kept; nothing is filtered. The gate is the product gate: FCP present as a
// finite number and <= launchShellPaintMs passes; a missing entry fails and is
// never speed evidence. Each launch lands in exactly one bucket. Exit 1 if any
// launch fails. Only probe-owned sessions are ever opened or closed.
//
// Usage (after `npm run e2e:seed`, with the release build served on
// E2E_FRONTEND_URL; see tests/e2e/README.md):
//   node tests/e2e/pwa-paint-probe.mjs [--launches=20] [--path=/roster] [--wait-ms=3000] [--signed-out]

const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const DEFAULT_ARTIFACT_DIR = path.join(ROOT, 'tests/artifacts/pwa-paint-probe')
const BUDGETS = JSON.parse(readFileSync(path.join(ROOT, 'tests/e2e/performance-budgets.json'), 'utf8')).globalBudgets
const COMMAND_TIMEOUT_MS = Number(process.env.E2E_PWA_LAUNCH_TIMEOUT_MS ?? 90_000)
const execFileAsync = promisify(execFile)
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

// `--name=value` and `--name value` are both accepted; a bare flag is an error.
export const readArg = (argv, name, fallback) => {
  const prefix = `--${name}=`
  const inline = argv.find((value) => value.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0) {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new RangeError(`--${name} needs a value`)
    return next
  }
  return fallback
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
export const isLoopbackUrl = (value) => {
  try { return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase()) } catch { return false }
}

const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

// agent-browser prints an eval result as a JSON string literal (the value is
// double-encoded), exactly what browser-pwa-launch.mjs decodes: take the last
// non-empty line, parse it, and parse again when it is a string.
export const parseEvalJson = (output) => {
  const line = String(output).split('\n').filter((value) => value.trim()).at(-1)
  if (line === undefined) throw new Error('eval returned no output')
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

// Runs at document start once registered through CDP: records paint entries as
// the engine emits them and exposes them for the late read.
export const EARLY_OBSERVER_SCRIPT = `(() => {
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

// Everything the diagnosis needs, read in one round trip after the settle wait.
export const PAINT_STATE = `(async () => {
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

// Attach to the session's page target over the browser CDP endpoint and
// register the early observer. The returned handle keeps the client attached
// (the script belongs to that CDP session) until `finish` removes the script
// and closes the client after the paint read.
export const beginEarlyObserver = async (browser, session, { openClient = openCdpClient } = {}) => {
  const outcome = { registered: false, identifier: null, error: null, endpointHost: null }
  let client = null
  let cdpSessionId = null
  try {
    const output = await browser(session, ['get', 'cdp-url'])
    const endpoint = String(output).match(/ws:\/\/\S+/)?.[0]
    if (!endpoint) throw new Error('no CDP endpoint from agent-browser')
    outcome.endpointHost = new URL(endpoint).hostname
    client = await openClient(endpoint)
    const { targetInfos } = await client.send('Target.getTargets')
    const page = selectCdpPageTarget(targetInfos)
    if (!page) throw new Error('no page target')
    const attached = await client.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    cdpSessionId = attached.sessionId
    await client.send('Page.enable', {}, cdpSessionId)
    const result = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: EARLY_OBSERVER_SCRIPT }, cdpSessionId)
    outcome.registered = true
    outcome.identifier = result.identifier ?? null
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error)
    client?.close()
    client = null
  }
  return {
    outcome,
    async finish() {
      if (!client) return
      try {
        if (outcome.identifier != null) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: outcome.identifier }, cdpSessionId)
      } catch (error) {
        outcome.removeError = error instanceof Error ? error.message : String(error)
      } finally {
        client.close()
        client = null
      }
    },
  }
}

// Sample allocation: launches alternate FRESH (odd-numbered) and REUSED
// (even-numbered) so the two conditions are interleaved in time rather than
// blocked, and any drift on the host affects both equally.
export const allocateLaunches = (count) => Array.from({ length: parseCount(count) }, (_, index) => ({
  index: index + 1,
  mode: index % 2 === 0 ? 'fresh' : 'reused',
}))

// Verdict buckets, exhaustive and mutually exclusive:
export const BUCKETS = ['pass', 'budget', 'missing:early-saw', 'missing:early-none', 'missing:early-error', 'missing:late-observer-saw', 'missing:no-evidence', 'probe-error']

// The product gate. A timing that is not a finite number >= 0 is missing:
// undefined, NaN, Infinity or a negative value can never pass. The early
// observer counts as having RUN only when the page exposed its store.
export const judgeLaunch = (state, budgetMs) => {
  const fcp = state?.fcpByType
  if (typeof fcp === 'number' && Number.isFinite(fcp) && fcp >= 0) {
    if (fcp > budgetMs) return { status: 'FAIL', bucket: 'budget', reason: `budget: fcp ${Math.round(fcp)}ms > ${budgetMs}ms` }
    return { status: 'PASS', bucket: 'pass', reason: `fcp ${Math.round(fcp)}ms <= ${budgetMs}ms` }
  }
  const early = state?.paintEarly
  const earlyRan = early != null && Array.isArray(early.entries)
  const earlySaw = earlyRan && early.entries.some((entry) => entry?.name === 'first-contentful-paint')
  const lateSaw = Array.isArray(state?.paintObserved) && state.paintObserved.some((entry) => entry?.name === 'first-contentful-paint')
  if (earlyRan && early.error) return { status: 'FAIL', bucket: 'missing:early-error', reason: `missing-timing: early observer ran but errored (${early.error}); no first-contentful-paint via getEntriesByType` }
  if (earlySaw) return { status: 'FAIL', bucket: 'missing:early-saw', reason: 'missing-timing: no first-contentful-paint via getEntriesByType, but the early observer saw it (entry produced, not exposed to the gate reader)' }
  if (earlyRan) return { status: 'FAIL', bucket: 'missing:early-none', reason: 'missing-timing: no first-contentful-paint anywhere; the early observer ran from document start and saw none (engine emitted no paint entry for this document)' }
  if (lateSaw) return { status: 'FAIL', bucket: 'missing:late-observer-saw', reason: 'missing-timing: no first-contentful-paint via getEntriesByType (present via late buffered observer; no early observer ran)' }
  return { status: 'FAIL', bucket: 'missing:no-evidence', reason: 'missing-timing: no-late-reader-evidence (no early observer ran; neither late reader saw first-contentful-paint; engine output not established)' }
}

// Close exactly one probe-owned session; never anything else on the host.
const closeOwnedSession = async (browser, session) => { await browser(session, ['close']) }

/** @param {string} message @param {{ setupAttempts: number }} counter */
const setupFailure = (message, counter) => Object.assign(new Error(message), { setupAttempts: counter.setupAttempts })

// Setup navigation (gate prelude and sign-in page): may retry; the count is
// carried on success and on the thrown error so the record always has it.
const openSetupPage = async (browser, session, url, counter) => {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    counter.setupAttempts += 1
    try {
      await browser(session, ['open', url], { timeout: COMMAND_TIMEOUT_MS })
      return
    } catch (error) {
      lastError = error
      await browser(session, ['wait', '1000']).catch(() => {})
    }
  }
  throw setupFailure(`setup navigation failed after ${counter.setupAttempts} attempt(s): ${lastError instanceof Error ? lastError.message : 'unknown error'}`, counter)
}

// The launch gate's prelude, verbatim: a signed-out launch of "/", a cleared
// localStorage relaunch, a 2500 ms settle, sign-in, a 2000 ms settle. The
// measured relaunch of the route follows in the caller.
const runGatePrelude = async (browser, evaluate, session, frontendUrl, user, password, counter, signedOut) => {
  await openSetupPage(browser, session, joinUrl(frontendUrl, '/'), counter)
  await browser(session, ['eval', 'try { localStorage.clear() } catch (e) {}'])
  await openSetupPage(browser, session, joinUrl(frontendUrl, '/'), counter)
  await browser(session, ['wait', '2500'])
  if (signedOut) return
  await openSetupPage(browser, session, joinUrl(frontendUrl, '/sign-in'), counter)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await fillSignInCredentials(browser, session, user.email, password); break } catch { await browser(session, ['wait', '1000']).catch(() => {}) }
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
    if (state.path === '/' && state.text > 0) { await browser(session, ['wait', '2000']); return }
    await browser(session, ['wait', '1000']).catch(() => {})
  }
  throw setupFailure('sign-in did not reach the app', counter)
}

/**
 * @param {{ browserFactory?: () => import('./browser-agent.mjs').Browser, argv?: string[], launches?: number, waitMs?: number, route?: string, signedOut?: boolean, env?: any, readState?: () => Promise<any>, artifactDir?: string, earlyObserver?: typeof beginEarlyObserver, verifySignIn?: (credentials: { email: string, password: string }) => Promise<{ error: { message: string } | null }>, log?: (line: string) => void, ownedSessions?: Set<string> }} [options]
 */
export const runPaintProbe = async (options = {}) => {
  const argv = options.argv ?? process.argv.slice(2)
  const browser = (options.browserFactory ?? (() => createBrowser({ cwd: ROOT, defaultTimeout: COMMAND_TIMEOUT_MS })))()
  const evaluate = async (session, expression) => parseEvalJson(await browser(session, ['eval', expression]))
  const earlyObserver = options.earlyObserver ?? beginEarlyObserver
  const log = options.log ?? console.log
  const owned = options.ownedSessions ?? new Set()
  const ROUTE = options.route ?? readArg(argv, 'path', '/roster')
  const SIGNED_OUT = options.signedOut ?? argv.includes('--signed-out')
  const ARTIFACT_DIR = options.artifactDir ?? DEFAULT_ARTIFACT_DIR
  const LAUNCHES = parseCount(options.launches ?? readArg(argv, 'launches', 20))
  const WAIT_MS = parseWaitMs(options.waitMs ?? readArg(argv, 'wait-ms', 3000))
  const env = options.env ?? resolvedEnv()
  const frontendUrl = env.frontendUrl
  if (!isLoopbackUrl(frontendUrl)) throw new Error(`probe only runs against a loopback frontend (got ${frontendUrl})`)
  if (!SIGNED_OUT && !isLoopbackUrl(env.supabaseUrl ?? '')) throw new Error(`probe only signs in against a loopback Supabase endpoint (got ${env.supabaseUrl ?? 'none'})`)
  await mkdir(ARTIFACT_DIR, { recursive: true })

  let user = null
  let password = null
  if (!SIGNED_OUT) {
    const state = options.readState ? await options.readState() : JSON.parse(await readFile(STATE_PATH, 'utf8'))
    user = state.users[0]
    password = state.password
    if (!env.anonKey) throw new Error('anonKey is required for a signed-in probe')
    // Same identity check the gate makes before trusting what the shell paints.
    const verify = options.verifySignIn ?? (async () => {
      const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
      return client.auth.signInWithPassword({ email: user.email, password })
    })
    const { error } = await verify({ email: user.email, password })
    if (error) throw new Error(`seeded user cannot sign in: ${error.message}`)
  }

  const launches = allocateLaunches(LAUNCHES)
  /** @type {Array<Record<string, any>>} */
  const results = []
  const runTag = `${process.pid}-${randomBytes(3).toString('hex')}`
  const reusedSession = `pwa-paint-probe-reused-${runTag}`
  let reusedPreludeDone = false
  const startedAt = new Date().toISOString()

  for (const launch of launches) {
    const session = launch.mode === 'fresh' ? `pwa-paint-probe-fresh-${runTag}-${launch.index}` : reusedSession
    owned.add(session)
    const counter = { setupAttempts: 0 }
    /** @type {Record<string, any>} */
    const record = { ...launch, session, startedAt: new Date().toISOString(), url: joinUrl(frontendUrl, ROUTE), setupAttempts: 0, measuredNavigationAttempts: 0, prelude: launch.mode === 'fresh' ? 'full gate prelude' : (reusedPreludeDone ? 'none (session already signed in)' : 'full gate prelude') }
    let early = null
    try {
      if (launch.mode === 'fresh' || !reusedPreludeDone) {
        await runGatePrelude(browser, evaluate, session, frontendUrl, user, password, counter, SIGNED_OUT)
        if (launch.mode === 'reused') reusedPreludeDone = true
      }
      record.setupAttempts = counter.setupAttempts
      // Early reader, registered before the measured navigation and kept attached through it.
      early = await earlyObserver(browser, session)
      record.earlyObserver = { ...early.outcome, ran: false }
      // Measured navigation: exactly one attempt, whatever happens is the result.
      record.measuredNavigationAttempts = 1
      await browser(session, ['open', record.url], { timeout: COMMAND_TIMEOUT_MS })
      await browser(session, ['wait', String(WAIT_MS)])
      const state = await evaluate(session, PAINT_STATE)
      record.earlyObserver.ran = state.paintEarly != null
      const shot = `launch-${String(launch.index).padStart(2, '0')}-${launch.mode}.png`
      await captureBrowserScreenshot(browser, session, ARTIFACT_DIR, shot).catch(() => {})
      Object.assign(record, { state, screenshot: shot, ...judgeLaunch(state, BUDGETS.launchShellPaintMs) })
    } catch (error) {
      record.setupAttempts = /** @type {{ setupAttempts?: number }} */ (error ?? {}).setupAttempts ?? counter.setupAttempts
      Object.assign(record, { status: 'FAIL', bucket: 'probe-error', reason: `probe error: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      await early?.finish().catch(() => {})
      if (launch.mode === 'fresh') {
        try { await closeOwnedSession(browser, session); owned.delete(session) } catch (error) { record.closeError = error instanceof Error ? error.message : String(error) }
      }
    }
    record.finishedAt = new Date().toISOString()
    results.push(record)
    log(`launch ${String(launch.index).padStart(2)} ${launch.mode.padEnd(6)} ${record.status} [${record.bucket}] ${record.reason}` +
      (record.state ? ` | early=${record.earlyObserver?.ran ? (record.state.paintEarly?.entries?.length ?? 0) : (record.earlyObserver?.registered ? 'registered-not-run' : 'off')} byType=${record.state.paintByType.length} late=${record.state.paintObserved.length} shell=${record.state.shellMark?.toFixed?.(1)} mount=${record.state.mountMark?.toFixed?.(1)} vis=${record.state.visibilityState} focus=${record.state.hasFocus}` : ''))
  }
  try { await closeOwnedSession(browser, reusedSession); owned.delete(reusedSession) } catch (error) { results.push({ index: null, mode: 'reused', session: reusedSession, status: 'FAIL', bucket: 'probe-error', reason: `probe error: could not close the reused session: ${error instanceof Error ? error.message : String(error)}` }) }

  const buckets = Object.fromEntries(BUCKETS.map((bucket) => [bucket, results.filter((r) => r.bucket === bucket).length]))
  const summary = {
    fresh: { total: results.filter((r) => r.mode === 'fresh').length, pass: results.filter((r) => r.mode === 'fresh' && r.status === 'PASS').length },
    reused: { total: results.filter((r) => r.mode === 'reused' && r.index != null).length, pass: results.filter((r) => r.mode === 'reused' && r.status === 'PASS').length },
    earlyObserverRegistered: results.filter((r) => r.earlyObserver?.registered).length,
    earlyObserverRan: results.filter((r) => r.earlyObserver?.ran).length,
    buckets,
    readerLimit: 'when the early observer did not run, the remaining readers are post-navigation and an empty result cannot distinguish an evicted or unbuffered entry from one the engine never produced',
  }
  const report = {
    startedAt, finishedAt: new Date().toISOString(), frontendUrl, route: ROUTE, waitMs: WAIT_MS, signedIn: !SIGNED_OUT,
    budgetMs: BUDGETS.launchShellPaintMs,
    allocation: `${LAUNCHES} launches, alternating fresh (own session, full gate prelude, closed after) / reused (one session kept across all reused launches; prelude once, then measured relaunches only)`,
    sequence: 'gate prelude: open "/", clear localStorage, open "/", wait 2500 ms, sign in, wait 2000 ms; then early observer, one measured open of the route, wait, read, screenshot',
    agentBrowserVersion: (await execFileAsync('agent-browser', ['--version'], { cwd: ROOT }).then((r) => r.stdout.trim()).catch(() => 'unknown')),
    userAgent: results.find((r) => r.state)?.state.userAgent ?? null,
    summary, results,
  }
  await writeFile(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    '# PWA paint probe', '', `- Started: ${report.startedAt}`, `- Frontend: ${frontendUrl} route ${ROUTE}`, `- Allocation: ${report.allocation}`, `- Sequence: ${report.sequence}`,
    `- Gate: FCP present (finite, >= 0) and <= ${report.budgetMs} ms; a missing entry is a failure and says nothing about speed`, `- agent-browser: ${report.agentBrowserVersion}`, `- User agent: ${report.userAgent ?? 'n/a'}`, '',
    `Fresh: ${summary.fresh.pass}/${summary.fresh.total} pass. Reused: ${summary.reused.pass}/${summary.reused.total} pass. Early observer registered on ${summary.earlyObserverRegistered}, ran on ${summary.earlyObserverRan}. Buckets: ${BUCKETS.map((b) => `${b}=${buckets[b]}`).join(', ')}.`, '',
    `Reader limit: ${summary.readerLimit}.`, '',
    '| # | mode | status | bucket | reason | prelude | setup attempts | measured nav attempts | early observer | paint (early) | paint (byType) | paint (late observer) | shell ms | mount ms | visible | focus | nav |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.index ?? '-'} | ${r.mode} | ${r.status} | ${r.bucket} | ${r.reason} | ${r.prelude ?? '-'} | ${r.setupAttempts ?? '-'} | ${r.measuredNavigationAttempts ?? '-'} | ${r.earlyObserver ? (r.earlyObserver.ran ? 'ran' : r.earlyObserver.registered ? 'registered, did not run' : `not registered: ${r.earlyObserver.error}`) : '-'} | ${r.state?.paintEarly ? r.state.paintEarly.entries.map((e) => `${e.name}@${Math.round(e.startTime)}`).join(' ') || 'none' : '-'} | ${r.state ? r.state.paintByType.map((e) => `${e.name}@${Math.round(e.startTime)}`).join(' ') || 'none' : '-'} | ${r.state ? r.state.paintObserved.map((e) => `${e.name}@${Math.round(e.startTime)}`).join(' ') || 'none' : '-'} | ${r.state?.shellMark?.toFixed?.(1) ?? '-'} | ${r.state?.mountMark?.toFixed?.(1) ?? '-'} | ${r.state?.visibilityState ?? '-'} | ${r.state?.hasFocus ?? '-'} | ${r.state?.navigationType ?? '-'} |`),
  ]
  await writeFile(path.join(ARTIFACT_DIR, 'report.md'), `${lines.join('\n')}\n`)
  const failed = results.filter((r) => r.status !== 'PASS').length
  log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} launches recorded a first-contentful-paint within budget; report at ${path.relative(ROOT, ARTIFACT_DIR)}/report.md`)
  return { failed, results, report }
}

// Entry point: every browser session the probe touches is owned by a scenario
// resource owner, exactly like the launch gate (phase-8 run 1 failed with
// 'Cannot own browser session ... without an active scenario resource owner').
// A SIGINT/SIGTERM closes the probe-owned sessions before exiting.
export const runPaintProbeEntry = (options = {}) => {
  const ownedSessions = options.ownedSessions ?? new Set()
  const browserFactory = options.browserFactory ?? (() => createBrowser({ cwd: ROOT, defaultTimeout: COMMAND_TIMEOUT_MS }))
  const browser = browserFactory()
  const onSignal = (signal) => {
    Promise.allSettled([...ownedSessions].map((session) => browser(session, ['close']).catch(() => {}))).finally(() => {
      process.exitCode = 130
      process.exit()
    })
    void signal
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return runWithScenarioResourceOwner('pwa-paint-probe', () => runPaintProbe({ ...options, ownedSessions, browserFactory: () => browser }))
    .finally(() => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPaintProbeEntry()
    .then(({ failed }) => { process.exitCode = failed === 0 ? 0 : 1 })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

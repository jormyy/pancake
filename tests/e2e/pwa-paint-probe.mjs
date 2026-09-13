import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv } from './env.mjs'
import { captureBrowserScreenshot, createBrowser, fillSignInCredentials } from './browser-agent.mjs'

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
// The gate is the product gate: FCP present AND <= launchShellPaintMs passes;
// a missing entry is a failure ("unknown"), never a pass; an absent entry says
// nothing about app speed. Exit status is 1 if any launch fails.
//
// Usage (after `npm run e2e:seed`, with the release build served on the
// frontend URL, see tests/e2e/README.md):
//   node tests/e2e/pwa-paint-probe.mjs [--launches=20] [--path=/roster] [--wait-ms=3000] [--signed-out]

const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const ARTIFACT_DIR = path.join(ROOT, 'tests/artifacts/pwa-paint-probe')
const BUDGETS = JSON.parse(readFileSync(path.join(ROOT, 'tests/e2e/performance-budgets.json'), 'utf8')).globalBudgets
const COMMAND_TIMEOUT_MS = Number(process.env.E2E_PWA_LAUNCH_TIMEOUT_MS ?? 90_000)
const execFileAsync = promisify(execFile)

const arg = (name, fallback) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`))
  return match ? match.slice(name.length + 3) : fallback
}
const LAUNCHES = Math.max(1, Number(arg('launches', 20)))
const ROUTE = arg('path', '/roster')
const WAIT_MS = Math.max(0, Number(arg('wait-ms', 3000)))
const SIGNED_OUT = process.argv.includes('--signed-out')

const browser = createBrowser({ cwd: ROOT, defaultTimeout: COMMAND_TIMEOUT_MS })
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()
const parseEvalJson = (output) => {
  const start = output.indexOf('{')
  if (start < 0) throw new Error(`eval returned no JSON: ${output.slice(0, 200)}`)
  return JSON.parse(output.slice(start, output.lastIndexOf('}') + 1))
}
const evaluate = async (session, expression) => parseEvalJson(await browser(session, ['eval', expression]))

// Everything the diagnosis needs, read in one round trip.
const PAINT_STATE = `(async () => {
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

const closeEverySession = async () => {
  await execFileAsync('agent-browser', ['close', '--all'], { cwd: ROOT, timeout: COMMAND_TIMEOUT_MS }).catch(() => {})
}

const openPage = async (session, url) => {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await browser(session, ['open', url], { timeout: COMMAND_TIMEOUT_MS })
      return
    } catch (error) {
      lastError = error
      await browser(session, ['wait', '1000']).catch(() => {})
    }
  }
  throw new Error(`navigation failed after 3 attempts: ${lastError instanceof Error ? lastError.message : 'unknown error'}`)
}

const signIn = async (session, frontendUrl, email, password) => {
  await openPage(session, joinUrl(frontendUrl, '/sign-in'))
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
    if (state.path === '/' && state.text > 0) return
    await browser(session, ['wait', '1000']).catch(() => {})
  }
  throw new Error('sign-in did not reach the app')
}

// Sample allocation: launches alternate FRESH (odd-numbered) and REUSED
// (even-numbered) so the two conditions are interleaved in time rather than
// blocked, and any drift on the host affects both equally.
export const allocateLaunches = (count) => Array.from({ length: count }, (_, index) => ({
  index: index + 1,
  mode: index % 2 === 0 ? 'fresh' : 'reused',
}))

export const judgeLaunch = (state, budgetMs) => {
  if (state.fcpByType === null) return { status: 'FAIL', reason: 'missing-timing: no first-contentful-paint entry' }
  if (state.fcpByType > budgetMs) return { status: 'FAIL', reason: `budget: fcp ${Math.round(state.fcpByType)}ms > ${budgetMs}ms` }
  return { status: 'PASS', reason: `fcp ${Math.round(state.fcpByType)}ms <= ${budgetMs}ms` }
}

const main = async () => {
  const env = resolvedEnv()
  const frontendUrl = env.frontendUrl
  const frontendHost = new URL(frontendUrl).hostname
  if (!['127.0.0.1', 'localhost'].includes(frontendHost)) throw new Error(`probe only runs against a local frontend (got ${frontendHost})`)
  await mkdir(ARTIFACT_DIR, { recursive: true })

  let user = null
  let password = null
  if (!SIGNED_OUT) {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8'))
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
    const record = { ...launch, session, startedAt: new Date().toISOString(), url: joinUrl(frontendUrl, ROUTE) }
    try {
      if (launch.mode === 'fresh') {
        await closeEverySession()
        reusedSignedIn = false
        if (!SIGNED_OUT) await signIn(session, frontendUrl, user.email, password)
      } else if (!SIGNED_OUT && !reusedSignedIn) {
        await signIn(session, frontendUrl, user.email, password)
      }
      if (!SIGNED_OUT) reusedSignedIn = launch.mode === 'reused' ? true : reusedSignedIn
      await openPage(session, record.url)
      await browser(session, ['wait', String(WAIT_MS)])
      const state = await evaluate(session, PAINT_STATE)
      const shot = `launch-${String(launch.index).padStart(2, '0')}-${launch.mode}.png`
      await captureBrowserScreenshot(browser, session, ARTIFACT_DIR, shot).catch(() => {})
      Object.assign(record, { state, screenshot: shot, ...judgeLaunch(state, BUDGETS.launchShellPaintMs) })
      if (launch.mode === 'fresh') await browser(session, ['close']).catch(() => {})
    } catch (error) {
      Object.assign(record, { status: 'FAIL', reason: `probe error: ${error instanceof Error ? error.message : String(error)}` })
    }
    record.finishedAt = new Date().toISOString()
    results.push(record)
    console.log(`launch ${String(launch.index).padStart(2)} ${launch.mode.padEnd(6)} ${record.status} ${record.reason}` +
      (record.state ? ` | byType=${record.state.paintByType.length} observed=${record.state.paintObserved.length} shell=${record.state.shellMark?.toFixed?.(1)} mount=${record.state.mountMark?.toFixed?.(1)} vis=${record.state.visibilityState} focus=${record.state.hasFocus}` : ''))
  }
  await browser(reusedSession, ['close']).catch(() => {})

  const summary = {
    fresh: { total: results.filter((r) => r.mode === 'fresh').length, pass: results.filter((r) => r.mode === 'fresh' && r.status === 'PASS').length },
    reused: { total: results.filter((r) => r.mode === 'reused').length, pass: results.filter((r) => r.mode === 'reused' && r.status === 'PASS').length },
    missingByTypeButObserved: results.filter((r) => r.state && r.state.fcpByType === null && r.state.paintObserved.some((e) => e.name === 'first-contentful-paint')).length,
    missingEverywhere: results.filter((r) => r.state && r.state.fcpByType === null && !r.state.paintObserved.some((e) => e.name === 'first-contentful-paint')).length,
  }
  const report = {
    startedAt, finishedAt: new Date().toISOString(), frontendUrl, route: ROUTE, waitMs: WAIT_MS, signedIn: !SIGNED_OUT,
    budgetMs: BUDGETS.launchShellPaintMs, allocation: `${LAUNCHES} launches, alternating fresh (all sessions closed first) / reused`,
    agentBrowserVersion: (await execFileAsync('agent-browser', ['--version'], { cwd: ROOT }).then((r) => r.stdout.trim()).catch(() => 'unknown')),
    userAgent: results.find((r) => r.state)?.state.userAgent ?? null,
    summary, results,
  }
  await writeFile(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    '# PWA paint probe', '', `- Started: ${report.startedAt}`, `- Frontend: ${frontendUrl} route ${ROUTE}`, `- Allocation: ${report.allocation}`,
    `- Gate: FCP present and <= ${report.budgetMs} ms; a missing entry is a failure and says nothing about speed`, `- agent-browser: ${report.agentBrowserVersion}`, `- User agent: ${report.userAgent ?? 'n/a'}`, '',
    `Fresh: ${summary.fresh.pass}/${summary.fresh.total} pass. Reused: ${summary.reused.pass}/${summary.reused.total} pass. Missing by getEntriesByType but present via buffered observer: ${summary.missingByTypeButObserved}. Missing in both readers: ${summary.missingEverywhere}.`, '',
    '| # | mode | status | reason | paint (byType) | paint (observer) | shell ms | mount ms | visible | focus | nav |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.index} | ${r.mode} | ${r.status} | ${r.reason} | ${r.state ? r.state.paintByType.map((e) => `${e.name}@${Math.round(e.startTime)}`).join(' ') || 'none' : '-'} | ${r.state ? r.state.paintObserved.map((e) => `${e.name}@${Math.round(e.startTime)}`).join(' ') || 'none' : '-'} | ${r.state?.shellMark?.toFixed?.(1) ?? '-'} | ${r.state?.mountMark?.toFixed?.(1) ?? '-'} | ${r.state?.visibilityState ?? '-'} | ${r.state?.hasFocus ?? '-'} | ${r.state?.navigationType ?? '-'} |`),
  ]
  await writeFile(path.join(ARTIFACT_DIR, 'report.md'), `${lines.join('\n')}\n`)
  const failed = results.filter((r) => r.status !== 'PASS').length
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} launches recorded a first-contentful-paint within budget; report at ${path.relative(ROOT, ARTIFACT_DIR)}/report.md`)
  process.exitCode = failed === 0 ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

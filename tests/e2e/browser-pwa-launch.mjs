import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv } from './env.mjs'
import { captureBrowserScreenshot, createBrowser, fillSignInCredentials } from './browser-agent.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

// Installed-PWA launch gate.
//
// The web build is a client-rendered SPA. Before the static boot shell existed,
// nothing was on screen until the whole JS bundle had mounted React — seconds of
// blank screen on a cold launch and ~2s on a relaunch over a mobile link. This
// asserts the shell paints first, paints the *right* thing, hands off cleanly,
// and that the worker precached enough to relaunch offline.

const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-pwa-launch-report.json')
const BUDGETS = JSON.parse(readFileSync(path.join(ROOT, 'tests/e2e/performance-budgets.json'), 'utf8')).globalBudgets

const BOOT_SHELL_MARK = 'pancake-boot-shell'
const APP_MOUNTED_MARK = 'pancake-app-mounted'
const COMMAND_TIMEOUT_MS = Number(process.env.E2E_PWA_LAUNCH_TIMEOUT_MS ?? 90_000)

const browser = createBrowser({ cwd: ROOT, defaultTimeout: COMMAND_TIMEOUT_MS })
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const evaluate = async (session, expression) => parseEvalJson(await browser(session, ['eval', expression]))

const openPage = async (session, url, label, attempts = 3) => {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await browser(session, ['open', url], { timeout: COMMAND_TIMEOUT_MS })
      return
    } catch (error) {
      lastError = error
      await browser(session, ['wait', '1000']).catch(() => {})
    }
  }
  throw new Error(`${label}: navigation failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : 'unknown error'}`)
}

/** Everything the gate asserts on, read in one round trip. */
const LAUNCH_STATE = `(() => {
  const mark = (name) => performance.getEntriesByName(name)[0]?.startTime ?? null;
  const paint = performance.getEntriesByType('paint')
    .find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null;
  const root = document.getElementById('root');
  return JSON.stringify({
    path: location.pathname,
    shellMark: mark(${JSON.stringify(BOOT_SHELL_MARK)}),
    mountMark: mark(${JSON.stringify(APP_MOUNTED_MARK)}),
    firstContentfulPaint: paint,
    boot: window.__PANCAKE_BOOT__ ?? null,
    shellStillInDom: !!document.getElementById('pancake-boot-shell'),
    navRegions: document.querySelectorAll('nav, [role="navigation"]').length,
    rootText: root ? (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : '',
    swControlled: !!navigator.serviceWorker?.controller,
  });
})()`

const CACHED_BOOT_ASSETS = `(async () => {
  const worker = await fetch('/sw.js').then((response) => response.text());
  const declared = JSON.parse(/const PRECACHE_URLS = (\\[[^\\]]*\\])/.exec(worker)?.[1] ?? '[]');
  const keys = await caches.keys();
  const cached = new Set();
  for (const key of keys) {
    const cache = await caches.open(key);
    for (const request of await cache.keys()) cached.add(new URL(request.url).pathname);
  }
  return JSON.stringify({ declared, missing: declared.filter((url) => !cached.has(url)), cacheCount: keys.length });
})()`

const signIn = async (session, frontendUrl, email, password) => {
  await openPage(session, joinUrl(frontendUrl, '/sign-in'), 'sign-in')
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fillSignInCredentials(browser, session, email, password)
      break
    } catch {
      await browser(session, ['wait', '1000']).catch(() => {})
    }
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
    const state = await evaluate(session, LAUNCH_STATE)
    if (state.path === '/' && state.rootText) return
    await browser(session, ['wait', '1000']).catch(() => {})
  }
  throw new Error('sign-in did not reach the app')
}

export async function runBrowserPwaLaunchScenario({ season = 0 } = {}) {
  const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'anonKey'])
  const state = JSON.parse(await readFile(STATE_PATH, 'utf8'))
  const user = state.users[0]
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'pwa-launch')
  await mkdir(artifactDir, { recursive: true })

  const session = `pwa-launch-${season}-${process.pid}`
  const checks = []
  const record = (name, pass, detail) => checks.push({ name, status: pass ? 'PASS' : 'FAIL', detail })

  try {
    // Verify the signed-in identity is real before trusting what the shell paints.
    const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
    const { error } = await client.auth.signInWithPassword({ email: user.email, password: state.password })
    if (error) throw new Error(`fixture sign-in failed: ${error.message}`)

    // 1. Signed out: the chrome must never flash before the app decides.
    await openPage(session, joinUrl(env.frontendUrl, '/'), 'signed-out launch')
    await browser(session, ['eval', 'try { localStorage.clear() } catch (e) {}'])
    await openPage(session, joinUrl(env.frontendUrl, '/'), 'signed-out relaunch')
    await browser(session, ['wait', '2500'])
    const signedOut = await evaluate(session, LAUNCH_STATE)
    record('signed out never paints the app chrome',
      signedOut.boot === null && !signedOut.shellStillInDom,
      `boot=${JSON.stringify(signedOut.boot)} shellInDom=${signedOut.shellStillInDom}`)

    // 2. The exported document must not prerender a background that differs
    //    from the app's own, or a signed-out launch flashes it before React
    //    paints. react-navigation's light theme defaults to #F2F2F2 grey.
    const documentHtml = await fetch(joinUrl(env.frontendUrl, '/')).then((response) => response.text())
    record('the exported document prerenders no foreign background',
      !/rgba?\(\s*242\s*,\s*242\s*,\s*242/.test(documentHtml),
      documentHtml.match(/rgba?\([^)]*242[^)]*\)/)?.[0] ?? 'none')

    // 3. Sign in, then relaunch — the installed-PWA path.
    await signIn(session, env.frontendUrl, user.email, state.password)
    await browser(session, ['wait', '2000'])

    await openPage(session, joinUrl(env.frontendUrl, '/roster'), 'relaunch')
    await browser(session, ['wait', '3000'])
    const relaunch = await evaluate(session, LAUNCH_STATE)
    await captureBrowserScreenshot(browser, session, artifactDir, 'relaunch.png')

    record('the boot shell paints on a signed-in relaunch',
      relaunch.shellMark !== null, `shellMark=${relaunch.shellMark}`)
    record('the shell paints before the app takes over',
      relaunch.shellMark !== null && relaunch.mountMark !== null && relaunch.shellMark <= relaunch.mountMark,
      `shell=${relaunch.shellMark}ms mount=${relaunch.mountMark}ms`)
    record('useful chrome is on screen within the launch budget',
      relaunch.firstContentfulPaint !== null && relaunch.firstContentfulPaint <= BUDGETS.launchShellPaintMs,
      `fcp=${Math.round(relaunch.firstContentfulPaint ?? -1)}ms budget=${BUDGETS.launchShellPaintMs}ms`)
    record('the shell paints the cached league, team, and active route',
      !!relaunch.boot?.league && !!relaunch.boot?.team && relaunch.boot?.active === '/roster',
      `boot=${JSON.stringify(relaunch.boot)}`)
    record('the handoff leaves no duplicate chrome',
      !relaunch.shellStillInDom && relaunch.navRegions <= 2,
      `shellInDom=${relaunch.shellStillInDom} navRegions=${relaunch.navRegions}`)
    record('the shell never holds the screen alone past its budget',
      relaunch.mountMark !== null && relaunch.shellMark !== null &&
        relaunch.mountMark - relaunch.shellMark <= BUDGETS.launchShellHoldMaxMs,
      `held=${Math.round((relaunch.mountMark ?? 0) - (relaunch.shellMark ?? 0))}ms`)

    // 4. Background then foreground: an installed PWA spends most of its life
    //    suspended, and the worker re-checks for updates on every foreground.
    await browser(session, ['eval', `(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      return JSON.stringify({ hidden: true });
    })()`])
    await browser(session, ['wait', '1500'])
    await browser(session, ['eval', `(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      return JSON.stringify({ visible: true });
    })()`])
    await browser(session, ['wait', '3000'])
    const foreground = await evaluate(session, LAUNCH_STATE)
    record('returning to the foreground keeps the app on screen',
      foreground.rootText.length > 0 && !foreground.shellStillInDom,
      `text="${foreground.rootText.slice(0, 40)}" shellInDom=${foreground.shellStillInDom}`)

    // 5. Cache aging: the persisted screen caches expire, but the launch must
    //    still paint chrome immediately and refresh behind it.
    await browser(session, ['eval', `(() => {
      const aged = Date.now() - 1000 * 60 * 60 * 24 * 7;
      let rewritten = 0;
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith('pancake:')) continue;
        try {
          const parsed = JSON.parse(localStorage.getItem(key));
          if (!parsed || parsed.version !== 1) continue;
          parsed.savedAt = aged;
          localStorage.setItem(key, JSON.stringify(parsed));
          rewritten += 1;
        } catch {}
      }
      return JSON.stringify({ rewritten });
    })()`])
    await openPage(session, joinUrl(env.frontendUrl, '/roster'), 'aged-cache relaunch')
    await browser(session, ['wait', '4000'])
    const aged = await evaluate(session, LAUNCH_STATE)
    record('a week-old cache still paints the shell and refreshes behind it',
      aged.shellMark !== null && aged.rootText.length > 0,
      `shell=${aged.shellMark === null ? 'none' : Math.round(aged.shellMark) + 'ms'} text="${aged.rootText.slice(0, 40)}"`)

    // 6. The worker precached everything the shell boots from.
    const precache = await evaluate(session, CACHED_BOOT_ASSETS)
    record('the worker precached every boot asset it declares',
      precache.declared.length >= 3 && precache.missing.length === 0,
      `declared=${precache.declared.length} missing=${precache.missing.join(', ') || 'none'}`)

    // 7. Offline relaunch still reaches the app.
    await browser(session, ['network', 'offline', 'on']).catch(() => {})
    await openPage(session, joinUrl(env.frontendUrl, '/'), 'offline relaunch').catch(() => {})
    await browser(session, ['wait', '4000'])
    const offline = await evaluate(session, LAUNCH_STATE).catch(() => null)
    await captureBrowserScreenshot(browser, session, artifactDir, 'offline.png').catch(() => {})
    await browser(session, ['network', 'offline', 'off']).catch(() => {})
    record('an offline relaunch still reaches the app',
      !!offline && offline.rootText.length > 0,
      `text="${offline?.rootText?.slice(0, 60) ?? ''}"`)

    const report = {
      status: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      measurements: {
        shellPaintMs: relaunch.shellMark,
        appMountedMs: relaunch.mountMark,
        firstContentfulPaintMs: relaunch.firstContentfulPaint,
        shellHeldAloneMs: relaunch.mountMark !== null && relaunch.shellMark !== null
          ? relaunch.mountMark - relaunch.shellMark : null,
      },
      budgets: {
        launchShellPaintMs: BUDGETS.launchShellPaintMs,
        launchShellHoldMaxMs: BUDGETS.launchShellHoldMaxMs,
      },
      checks,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (report.status !== 'PASS') {
      const failures = checks.filter((check) => check.status !== 'PASS').map((check) => `${check.name} (${check.detail})`)
      throw new Error(`PWA launch gate failed: ${failures.join('; ')}`)
    }
    return report
  } finally {
    await browser(session, ['network', 'offline', 'off']).catch(() => {})
    await browser(session, ['close']).catch(() => {})
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  await runWithScenarioResourceOwner('pwa-launch', () => runBrowserPwaLaunchScenario({ season }))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

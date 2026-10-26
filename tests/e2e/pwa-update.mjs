import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createBrowser, openCdpClient, selectCdpPageTarget } from './browser-agent.mjs'
import { ownScenarioResource, runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { readPwaRelease } from './pwa-update-release.mjs'

// Two complete production exports, one origin, one automatic controller-change
// reload. This Chromium check does not prove installed PWA or Safari behavior.
const ROOT = process.cwd()
const BUDGETS = JSON.parse(await readFile(path.join(ROOT, 'tests/e2e/performance-budgets.json'), 'utf8')).globalBudgets
const ARTIFACT_DIR = path.resolve(process.env.E2E_PWA_UPDATE_ARTIFACT_DIR ??
  path.join(os.tmpdir(), `pancake-pwa-update-${process.pid}`))
const REPORT_PATH = path.resolve(process.env.E2E_PWA_UPDATE_REPORT_PATH ?? path.join(ARTIFACT_DIR, 'summary.json'))
const PORT = Number(process.env.E2E_PWA_UPDATE_PORT ?? 8801)
const TIMEOUT = Number(process.env.E2E_PWA_UPDATE_TIMEOUT_MS ?? 60_000)
const readArg = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const parseEvalJson = (output) => {
  const value = JSON.parse(output.split('\n').filter(Boolean).at(-1))
  return typeof value === 'string' ? JSON.parse(value) : value
}
const rawBrowser = createBrowser({ cwd: ROOT, defaultTimeout: TIMEOUT })
const browser = async (session, args) => {
  const started = new Date().toISOString()
  try {
    const output = await rawBrowser(session, args)
    await appendFile(path.join(ARTIFACT_DIR, 'commands.jsonl'),
      `${JSON.stringify({ started, command: ['agent-browser', '--session', session, ...args], output })}\n`)
    return output
  } catch (error) {
    await appendFile(path.join(ARTIFACT_DIR, 'commands.jsonl'),
      `${JSON.stringify({ started, command: ['agent-browser', '--session', session, ...args], error: String(error) })}\n`)
    throw error
  }
}

const serve = async (root, port) => {
  const proc = spawn('node', [path.join(ROOT, 'tests/e2e/static-web-server.mjs'), `--root=${root}`, `--port=${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let exit = false
  let launchError
  let ready = false
  let output = ''
  proc.on('error', (error) => { launchError = error })
  proc.on('exit', () => { exit = true })
  proc.stdout.on('data', (bytes) => { output += String(bytes); ready ||= output.includes('Static E2E web server listening') })
  proc.stderr.on('data', (bytes) => { output += String(bytes) })
  ownScenarioResource(`server:${proc.pid}`, `PWA update static server ${proc.pid}`, async () => {
    if (!exit) {
      proc.kill('SIGTERM')
      for (let attempt = 0; attempt < 50 && !exit; attempt += 1) await sleep(100)
      if (!exit) throw new Error('Owned PWA server did not stop')
    }
    await writeFile(path.join(ARTIFACT_DIR, 'server.log'), output)
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (launchError) throw launchError
    if (exit) throw new Error(`PWA static server exited before readiness: ${output}`)
    if (ready) return
    await sleep(100)
  }
  throw new Error('PWA static server readiness timed out')
}

const WORKER_STATE = `(async () => {
  const controller = navigator.serviceWorker.controller;
  const version = controller ? await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 3000);
    channel.port1.onmessage = event => {
      clearTimeout(timer); channel.port1.close(); resolve(event.data?.version ?? null);
    };
    controller.postMessage({type:'PANCAKE_WORKER_VERSION'}, [channel.port2]);
  }) : null;
  return JSON.stringify({
    origin: location.origin, version, timeOrigin: performance.timeOrigin,
    navigationType: performance.getEntriesByType('navigation')[0]?.type ?? null,
    navigation: performance.getEntriesByType('navigation')[0]?.toJSON() ?? null,
    online: navigator.onLine, cacheKeys: await caches.keys(),
    shellPaintMs: performance.getEntriesByName('pancake-boot-shell')[0]?.startTime ?? null,
    appMountedMs: performance.getEntriesByName('pancake-app-mounted')[0]?.startTime ?? null,
    firstContentfulPaintMs: performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime ?? null,
    mountedText: (document.getElementById('root')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,200),
    resources: performance.getEntriesByType('resource').filter(e => ['script','css','link'].includes(e.initiatorType))
      .map(e => ({url:e.name,startTime:e.startTime,duration:e.duration,transferSize:e.transferSize,workerStart:e.workerStart})),
    documentCount: Number(sessionStorage.getItem('pwa-update-documents') ?? '0'),
    probe: JSON.parse(sessionStorage.getItem('pwa-update-probe') ?? 'null')
  });
})()`

const cacheCheck = (release) => `(async () => {
  const expected = ${JSON.stringify(release.bootHashes)};
  const keys = await caches.keys();
  const problems = [];
  for (const [url, hash] of Object.entries(expected)) {
    const key = ${JSON.stringify(release.version)} + (url === '/' ? '-public-v1-shell' : '-public-v1-assets');
    if (!keys.includes(key)) { problems.push(url + ': cache missing'); continue; }
    const response = await (await caches.open(key)).match(url);
    if (!response) { problems.push(url + ': entry missing'); continue; }
    const bytes = await response.arrayBuffer();
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
      .map(n => n.toString(16).padStart(2,'0')).join('');
    if (actual !== hash) problems.push(url + ': wrong bytes');
  }
  return JSON.stringify({keys,checked:Object.keys(expected).length,problems});
})()`

const waitForState = async (session, predicate, read = async () => parseEvalJson(await browser(session, ['eval', WORKER_STATE]))) => {
  const deadline = Date.now() + TIMEOUT
  let state
  let lastError
  while (Date.now() < deadline) {
    try {
      state = await read()
      if (predicate(state)) return state
    } catch (error) { lastError = String(error) }
    await sleep(250)
  }
  throw new Error(`PWA state timed out: ${JSON.stringify({ state, lastError })}`)
}

/** @param {{ previousRoot?: string, nextRoot?: string }} options */
export async function runPwaUpdateGate({ previousRoot, nextRoot } = {}) {
  await mkdir(ARTIFACT_DIR, { recursive: true })
  await mkdir(path.dirname(REPORT_PATH), { recursive: true })
  const session = process.env.E2E_PWA_UPDATE_SESSION ?? `pwa-update-${process.pid}`
  const checks = []
  const report = { status: 'FAIL', previousRoot, nextRoot, origin: `http://127.0.0.1:${PORT}`,
    scope: 'Anonymous Chromium update and offline reload; actual registration.update API triggers the check. No Safari, signed-in upgrade, installed PWA or push claim.',
    checks, releases: null, before: null, after: null, offline: null, error: null }
  const record = (name, pass, detail) => {
    checks.push({ name, status: pass ? 'PASS' : 'FAIL', detail })
  }
  return runWithScenarioResourceOwner('pwa-update', async () => {
    if (!previousRoot || !nextRoot) throw new Error('pwa-update requires --previous=<dir> and --next=<dir>')
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PWA update port')
    const previous = await readPwaRelease(path.resolve(previousRoot))
    const next = await readPwaRelease(path.resolve(nextRoot))
    report.releases = { previous, next }
    record('distinct verified production releases', previous.version !== next.version && previous.bundleDigest !== next.bundleDigest,
      { previous: previous.version, next: next.version })
    if (checks.at(-1).status !== 'PASS') throw new Error('PWA update requires distinct releases')
    const liveRoot = await mkdtemp(path.join(ARTIFACT_DIR, 'origin-'))
    ownScenarioResource(`origin:${liveRoot}`, 'PWA origin symlink', () => rm(liveRoot, { recursive: true }))
    const live = path.join(liveRoot, 'current')
    await symlink(previous.root, live, 'dir')
    await serve(live, PORT)
    await browser(session, ['open', `${report.origin}/`])
    let before = await waitForState(session, state => state.version === previous.version && state.appMountedMs !== null && state.mountedText.length > 0)
    report.before = before
    record('previous controller is the previous release', before.origin === report.origin && before.version === previous.version, before)
    const previousCache = parseEvalJson(await browser(session, ['eval', cacheCheck(previous)]))
    record('previous boot cache contains exact release bytes', previousCache.problems.length === 0, previousCache)
    await browser(session, ['snapshot'])
    const endpoint = (await browser(session, ['get', 'cdp-url'])).match(/ws:\/\/\S+/)?.[0]
    if (!endpoint) throw new Error('Owned browser CDP endpoint is missing')
    const cdp = await openCdpClient(endpoint)
    ownScenarioResource(`cdp:${session}`, 'PWA document observer', async () => { cdp.close() })
    const { targetInfos } = await cdp.send('Target.getTargets')
    const page = selectCdpPageTarget(targetInfos)
    if (!page || new URL(page.url).origin !== report.origin) throw new Error('PWA observer target does not match the owned origin')
    const { sessionId } = await cdp.send('Target.attachToTarget', {targetId:page.targetId,flatten:true})
    await cdp.send('Page.enable', {}, sessionId)
    const scriptReceipt = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source:`
      if (window.top === window) {
        sessionStorage.setItem('pwa-update-documents',String(Number(sessionStorage.getItem('pwa-update-documents') || '0') + 1));
      }
    `}, sessionId)
    await appendFile(path.join(ARTIFACT_DIR, 'commands.jsonl'),`${JSON.stringify({command:['CDP','Page.enable','Page.addScriptToEvaluateOnNewDocument'],targetOrigin:report.origin,scriptReceipt})}\n`)
    await browser(session, ['reload'])
    before = await waitForState(session, state => state.version === previous.version && state.appMountedMs !== null && state.mountedText.length > 0)
    report.before = before
    record('document observer runs before deployment', before.documentCount === 1, {documentCount:before.documentCount})
    if (before.documentCount !== 1) throw new Error('Document observer did not run')
    await browser(session, ['eval', `(() => {
      sessionStorage.setItem('pwa-update-documents','0');
      const probe = {timeOrigin:performance.timeOrigin, controllerChanges:0, pageHides:0};
      const save = () => sessionStorage.setItem('pwa-update-probe',JSON.stringify(probe));
      navigator.serviceWorker.addEventListener('controllerchange',()=>{probe.controllerChanges++;save();});
      window.addEventListener('pagehide',()=>{probe.pageHides++;save();});
      save(); return JSON.stringify(probe);
    })()`])
    await symlink(next.root, path.join(liveRoot, 'next'), 'dir')
    await rename(path.join(liveRoot, 'next'), live)
    // No manual navigation occurs between the swap and the following assertion.
    await browser(session, ['eval', `(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('Previous registration missing');
      await registration.update(); return 'Update requested';
    })()`])
    const { targetId: backgroundTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    await cdp.send('Target.activateTarget', { targetId: backgroundTarget })
    let after = await waitForState(session, state => state.version === next.version && state.timeOrigin > before.timeOrigin && state.appMountedMs !== null && state.mountedText.length > 0, async () => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: WORKER_STATE, awaitPromise: true, returnByValue: true }, sessionId)
      return JSON.parse(result.value)
    })
    const { result: foregroundStart } = await cdp.send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true }, sessionId)
    await cdp.send('Target.activateTarget', { targetId: page.targetId })
    await cdp.send('Target.closeTarget', { targetId: backgroundTarget })
    after = await waitForState(session, state => state.version === next.version && state.firstContentfulPaintMs !== null && state.mountedText.length > 0)
    report.after = after
    record('first automatic reload uses the next controller at the same origin',
      after.origin === before.origin && after.navigationType === 'reload' && after.documentCount === 1 && after.probe?.controllerChanges === 1 && after.probe?.pageHides === 1,
      { navigationType: after.navigationType, documentCount: after.documentCount, probe: after.probe, version: after.version })
    const nextCache = parseEvalJson(await browser(session, ['eval', cacheCheck(next)]))
    record('next boot cache contains exact release bytes', nextCache.problems.length === 0, nextCache)
    record('activation removes old Pancake caches', nextCache.keys.filter(key => key.startsWith('pancake-')).every(key => key.startsWith(`${next.version}-`)), nextCache.keys)
    const foregroundPaintMs = Math.max(0, after.firstContentfulPaintMs - foregroundStart.value)
    record('updated document paints within the launch budget after foregrounding',
      foregroundPaintMs <= BUDGETS.launchShellPaintMs,
      { observed: foregroundPaintMs, budget: BUDGETS.launchShellPaintMs, navigationPaintMs: after.firstContentfulPaintMs, foregroundStartMs: foregroundStart.value })
    await browser(session, ['snapshot'])
    await browser(session, ['screenshot', path.join(ARTIFACT_DIR, 'first-update.png')])
    await browser(session, ['console'])
    record('no browser errors during update', (await browser(session, ['errors'])).trim() === '', 'See command log')
    await browser(session, ['set', 'offline', 'on'])
    const offlineProbe = parseEvalJson(await browser(session, ['eval', `(async () => {
      let networkBlocked = false;
      try { await fetch('/release-provenance.json?offline-probe='+Date.now(),{cache:'no-store'}); }
      catch { networkBlocked = true; }
      return JSON.stringify({online:navigator.onLine,networkBlocked});
    })()`]))
    record('browser network is actually unavailable', !offlineProbe.online && offlineProbe.networkBlocked, offlineProbe)
    await browser(session, ['reload'])
    const offline = await waitForState(session, state => state.version === next.version && state.timeOrigin > after.timeOrigin && state.appMountedMs !== null && state.mountedText.length > 0)
    report.offline = offline
    const afterOfflineProbe = parseEvalJson(await browser(session, ['eval', `(async () => {
      let networkBlocked = false;
      try { await fetch('/release-provenance.json?offline-after='+Date.now(),{cache:'no-store'}); }
      catch { networkBlocked = true; }
      return JSON.stringify({online:navigator.onLine,networkBlocked});
    })()`]))
    record('network remains unavailable after reload', afterOfflineProbe.networkBlocked, afterOfflineProbe)
    record('offline reload mounts the updated release', offline.mountedText === after.mountedText && offline.navigationType === 'reload' && offline.documentCount === 2, offline)
    await browser(session, ['snapshot'])
    await browser(session, ['screenshot', path.join(ARTIFACT_DIR, 'offline-update.png')])
    await browser(session, ['console'])
    await browser(session, ['errors'])
    if (checks.some(check => check.status !== 'PASS')) {
      throw new Error(`PWA update checks failed: ${checks.filter(check => check.status !== 'PASS').map(check => check.name).join('; ')}`)
    }
    return report
  }, {
    onComplete: async ({outcome, primaryError, cleanupError}) => {
      report.status = outcome.ok && !primaryError && !cleanupError ? 'PASS' : 'FAIL'
      report.error = [primaryError, cleanupError].filter(Boolean).map(String).join('; ') || null
      await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
      if (REPORT_PATH !== path.join(ARTIFACT_DIR, 'summary.json')) {
        await writeFile(path.join(ARTIFACT_DIR, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
      }
    },
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runPwaUpdateGate({ previousRoot: readArg('previous'), nextRoot: readArg('next') })
    .then((report) => console.log(JSON.stringify({ status: report.status, origin: report.origin })))
    .catch((error) => { console.error(error); process.exitCode = 1 })
}

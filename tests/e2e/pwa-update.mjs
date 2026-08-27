import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createBrowser } from './browser-agent.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

// Deploy-update gate. Serves a previous release, installs its worker, swaps the
// origin to the next release, and proves the update lands warm.
//
// Before the worker precached its boot bundle, this was the worst launch in the
// product: activate() dropped the previous release's caches and the forced
// reload then re-downloaded everything, so every deploy showed a blank screen.
//
//   node tests/e2e/pwa-update.mjs --previous=<dist-dir> --next=<dist-dir>

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-pwa-update-report.json')
const ARTIFACT_DIR = path.join(ROOT, 'tests/artifacts/pwa-update')
const PREVIOUS_PORT = Number(process.env.E2E_PWA_UPDATE_PREVIOUS_PORT ?? 8801)
const NEXT_PORT = Number(process.env.E2E_PWA_UPDATE_NEXT_PORT ?? 8802)
const COMMAND_TIMEOUT_MS = Number(process.env.E2E_PWA_UPDATE_TIMEOUT_MS ?? 90_000)

const browser = createBrowser({ cwd: ROOT, defaultTimeout: COMMAND_TIMEOUT_MS })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readArg = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1]

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const serve = (root, port) =>
  new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(ROOT, 'tests/e2e/static-web-server.mjs'), `--root=${root}`, `--port=${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.on('error', reject)
    proc.stdout.once('data', async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await fetch(`http://127.0.0.1:${port}/`).then((response) => response.ok).catch(() => false)) {
          resolve(proc)
          return
        }
        await sleep(150)
      }
      reject(new Error(`static server for ${root} never became ready`))
    })
  })

/** The worker's own claims, and whether the caches actually back them. */
const WORKER_STATE = `(async () => {
  const worker = await fetch('/sw.js', { cache: 'no-store' }).then((response) => response.text());
  const version = /const VERSION = '([^']*)'/.exec(worker)?.[1] ?? null;
  const declared = JSON.parse(/const PRECACHE_URLS = (\\[[^\\]]*\\])/.exec(worker)?.[1] ?? '[]');
  const keys = await caches.keys();
  const cached = new Set();
  for (const key of keys) {
    const cache = await caches.open(key);
    for (const request of await cache.keys()) cached.add(new URL(request.url).pathname);
  }
  const root = document.getElementById('root');
  return JSON.stringify({
    version,
    declaredCount: declared.length,
    missing: declared.filter((url) => !cached.has(url)),
    cacheKeys: keys,
    shellPaintMs: performance.getEntriesByName('pancake-boot-shell')[0]?.startTime ?? null,
    appMountedMs: performance.getEntriesByName('pancake-app-mounted')[0]?.startTime ?? null,
    firstContentfulPaint: performance.getEntriesByType('paint')
      .find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null,
    mountedText: root ? (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '',
  });
})()`

/** @param {{ previousRoot?: string, nextRoot?: string }} options */
export async function runPwaUpdateGate({ previousRoot, nextRoot } = {}) {
  if (!previousRoot || !nextRoot) throw new Error('pwa-update requires --previous=<dir> and --next=<dir>')
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const session = `pwa-update-${process.pid}`
  const checks = []
  const record = (name, pass, detail) => checks.push({ name, status: pass ? 'PASS' : 'FAIL', detail })

  const previous = await serve(previousRoot, PREVIOUS_PORT)
  const next = await serve(nextRoot, NEXT_PORT)
  try {
    // 1. Install the previous release.
    await browser(session, ['open', `http://127.0.0.1:${PREVIOUS_PORT}/`])
    await browser(session, ['wait', '5000'])
    const before = parseEvalJson(await browser(session, ['eval', WORKER_STATE]))
    record('the previous release precaches every boot asset it declares',
      before.declaredCount >= 3 && before.missing.length === 0,
      `version=${before.version?.slice(0, 26)} declared=${before.declaredCount} missing=${before.missing.length}`)

    // 2. Deploy the next release to the same origin and relaunch.
    await browser(session, ['open', `http://127.0.0.1:${NEXT_PORT}/`])
    await browser(session, ['wait', '10000'])
    await browser(session, ['open', `http://127.0.0.1:${NEXT_PORT}/`])
    await browser(session, ['wait', '5000'])
    const after = parseEvalJson(await browser(session, ['eval', WORKER_STATE]))

    record('the next release precaches its own boot assets',
      after.declaredCount >= 3 && after.missing.length === 0,
      `version=${after.version?.slice(0, 26)} declared=${after.declaredCount} missing=${after.missing.join(', ') || 'none'}`)
    record('only the activated release keeps caches',
      after.cacheKeys.length > 0 && after.cacheKeys.every((key) => key.startsWith(after.version)),
      `caches=${after.cacheKeys.length}`)
    record('the first relaunch after the deploy still mounts the app',
      after.mountedText.length > 0, `text="${after.mountedText.slice(0, 48)}"`)

    const report = {
      status: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
      previousRoot, nextRoot,
      previousVersion: before.version,
      nextVersion: after.version,
      measurements: {
        shellPaintMs: after.shellPaintMs,
        appMountedMs: after.appMountedMs,
        firstContentfulPaintMs: after.firstContentfulPaint,
      },
      checks,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(ARTIFACT_DIR, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (report.status !== 'PASS') {
      throw new Error(`PWA update gate failed: ${checks.filter((c) => c.status !== 'PASS').map((c) => `${c.name} (${c.detail})`).join('; ')}`)
    }
    return report
  } finally {
    await browser(session, ['close']).catch(() => {})
    previous.kill()
    next.kill()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runWithScenarioResourceOwner('pwa-update', () =>
    runPwaUpdateGate({ previousRoot: readArg('previous'), nextRoot: readArg('next') }))
    .then((report) => console.log(JSON.stringify(report.measurements)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { readPwaRelease } from './pwa-update-release.mjs'
import { openWebTarget } from './web-targets-browser.mjs'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const workerState = (page) => page.evaluate(async () => {
  const worker = navigator.serviceWorker.controller
  const version = worker ? await new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => { channel.port1.close(); resolve(null) }, 3000)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(event.data?.version)
    }
    worker.postMessage({ type: 'PANCAKE_WORKER_VERSION' }, [channel.port2])
  }) : null
  return { version, observedVersion: sessionStorage.getItem('pancake-sw-worker-version'),
    documents: Number(sessionStorage.getItem('web-target-update-documents')),
    mounted: performance.getEntriesByName('pancake-app-mounted').length > 0 }
})

async function waitForWorker(page, version, documents = 1) {
  let state = null
  for (let attempt = 0; attempt < 160; attempt += 1) {
    state = await workerState(page).catch(() => null)
    if (state?.version === version && state.observedVersion === version && state.mounted && state.documents >= documents) return state
    await wait(250)
  }
  throw new Error(`Worker did not reach ${version}: ${JSON.stringify(state)}`)
}

export async function runWebTargetUpdates({ previousRoot, nextRoot, artifactDir, targets }) {
  await mkdir(artifactDir, { recursive: true })
  const previous = await readPwaRelease(path.resolve(previousRoot))
  const next = await readPwaRelease(path.resolve(nextRoot))
  assert.notEqual(previous.version, next.version, 'Updates require two distinct complete stamped exports')
  const originDir = await mkdtemp(path.join(artifactDir, 'origin-'))
  const current = path.join(originDir, 'current')
  const port = Number(process.env.E2E_WEB_TARGET_UPDATE_PORT ?? 8805)
  const server = spawn(process.execPath, [path.resolve('tests/e2e/static-web-server.mjs'), `--root=${current}`, `--port=${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  let stopped = false
  server.stdout.on('data', (data) => { log += data })
  server.stderr.on('data', (data) => { log += data })
  server.on('exit', () => { stopped = true })
  const report = { status: 'FAIL', previous: previous.version, next: next.version, targets: [] }
  try {
    await symlink(previous.root, current, 'dir')
    for (let attempt = 0; !log.includes('Static E2E web server listening') && attempt < 100; attempt += 1) {
      if (stopped) throw new Error(`Update server exited: ${log}`)
      await wait(100)
    }
    assert.ok(log.includes('Static E2E web server listening'), 'Update server must start')
    for (const target of targets) {
      const captures = path.join(artifactDir, target.id)
      await mkdir(captures, { recursive: true })
      await rm(current)
      await symlink(previous.root, current, 'dir')
      const { browser, context, page } = await openWebTarget(target, captures)
      const result = { id: target.id, status: 'FAIL', before: null, after: null, offline: null, error: null }
      report.targets.push(result)
      try {
        await context.addInitScript(() => {
          sessionStorage.setItem('web-target-update-documents', String(Number(sessionStorage.getItem('web-target-update-documents') ?? 0) + 1))
        })
        await page.goto(`http://127.0.0.1:${port}/`)
        result.before = await waitForWorker(page, previous.version)
        await symlink(next.root, path.join(originDir, 'next'), 'dir')
        await rename(path.join(originDir, 'next'), current)
        await page.evaluate(async () => (await navigator.serviceWorker.ready).update())
        result.after = await waitForWorker(page, next.version, result.before.documents + 1)
        assert.equal(result.after.documents, result.before.documents + 1, 'Controller update reloads exactly once')
        await wait(1000)
        assert.equal((await workerState(page)).documents, result.after.documents, 'Update must not reload in a loop')
        const cached = await page.evaluate(async (hashes) => {
          const failures = []
          for (const [url, expected] of Object.entries(hashes)) {
            const response = await caches.match(url)
            if (!response) { failures.push(`${url}: missing`); continue }
            const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))]
              .map((byte) => byte.toString(16).padStart(2, '0')).join('')
            if (hash !== expected) failures.push(`${url}: wrong bytes`)
          }
          return failures
        }, next.bootHashes)
        assert.deepEqual(cached, [], 'The updated worker must cache the next release bytes')
        await context.setOffline(true)
        await page.reload({ waitUntil: 'load' })
        result.offline = await waitForWorker(page, next.version, result.after.documents + 1)
        assert.equal(result.offline.documents, result.after.documents + 1)
        await page.screenshot({ path: path.join(captures, 'updated-offline.png') })
        result.status = 'PASS'
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
        await page.screenshot({ path: path.join(captures, 'failure.png') }).catch(() => {})
      } finally {
        await context.close()
        await browser.close()
      }
    }
    report.status = report.targets.every((target) => target.status === 'PASS') ? 'PASS' : 'FAIL'
    return report
  } finally {
    if (!stopped) server.kill('SIGTERM')
    for (let attempt = 0; !stopped && attempt < 50; attempt += 1) await wait(100)
    await writeFile(path.join(artifactDir, 'server.log'), log)
    await writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
    await rm(originDir, { recursive: true })
  }
}

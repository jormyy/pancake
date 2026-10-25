import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'vitest'
import { lock, localUrl, pause, stopChild } from '../../scripts/ios-sim/common.mjs'
import { Driver } from '../../scripts/ios-sim/driver.mjs'
import { recorderSource } from '../../scripts/ios-sim/recorder.mjs'
import { failures, writeReport } from '../../scripts/ios-sim/report.mjs'
import * as runner from '../../scripts/ios-sim/run.mjs'
import { resolveOptions } from '../../scripts/ios-sim/run.mjs'
import { buildFixture } from './build-fixture.mjs'
import { resolveFile, serve } from '../../scripts/ios-sim/server.mjs'
import { copyStackSources, stackConfig } from '../../scripts/ios-sim/stack.mjs'

class Element {
  tagName = 'DIV'
  text = 'Loading'
  y = 10
  get childNodes() { return [{ nodeType: 3, textContent: this.text }] }
  getBoundingClientRect() { return { x: 10, y: this.y, width: 100, height: 20, top: this.y, left: 10, bottom: this.y + 20, right: 110 } }
  getAttribute(name: string) { return name === 'role' ? 'heading' : null }
}

function recorder(failedUploads = 0) {
  let now = 0, counter = 0
  const queue = new Map<number, () => void>()
  const posted: Record<string, unknown>[] = []
  const controls: { onmessage?: (event: { data: string }) => void }[] = []
  const elements = [new Element()]
  const handlers = new Map<string, () => void>()
  const storage = new Map()
  const resetEvents: string[] = []
  const document = { hidden: false, documentElement: {}, querySelector: () => ({ getAttribute: () => 'fixture-source' }), querySelectorAll: () => elements, addEventListener: (event: string, callback: () => void) => handlers.set(event, callback) }
  const context = {
    document, navigator: { standalone: true, serviceWorker: { getRegistrations: async () => [{ unregister: async () => { resetEvents.push('unregister') } }] } }, innerWidth: 402, innerHeight: 812,
    location: { href: 'http://127.0.0.1:58190/', pathname: '/', search: '', replace: (url: string) => resetEvents.push(url) },
    performance: { now: () => now, timeOrigin: 0 }, Date: { now: () => now },
    localStorage: { clear: () => {} },
    caches: { keys: async () => ['pancake-old-public-shell', 'unrelated'], delete: async (name: string) => { resetEvents.push(name) } },
    sessionStorage: { clear: () => storage.clear(), getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (callback: () => void) => { queue.set(++counter, callback); return counter },
    cancelAnimationFrame: (id: number) => queue.delete(id),
    MutationObserver: class { observe() {} disconnect() {} },
    EventSource: class { constructor() { controls.push(this) } onmessage?: (event: { data: string }) => void; close() {} },
    XMLHttpRequest: class { open() {} send() {} },
    fetch: async (_url: string, options: { body?: string }) => {
      if (options?.body) {
        if (failedUploads-- > 0) throw new Error('Report connection lost')
        posted.push(JSON.parse(options.body))
      }
      return { ok: true }
    },
  }
  const scope = vm.createContext({ ...context, window: context })
  vm.runInContext(recorderSource, scope)
  const api = (context as typeof context & { __iosRecorder: { begin: (spec: object) => void, finish: (settled: boolean) => unknown } }).__iosRecorder
  const frame = (time: number) => { now = time; const jobs = [...queue.values()]; queue.clear(); for (const job of jobs) job() }
  return { api, frame, elements, posted, handlers, document, queue, resetEvents, fetch: context.fetch, message: (value: object) => controls[0].onmessage!({ data: JSON.stringify(value) }) }
}

test('recorder waits for real content and records appearance, loss, text, and movement', () => {
  const r = recorder()
  r.api.begin({ id: 'players', expected: { text: 'Real player' }, immediate: true, minimumMs: 100, quietMs: 20, maximumMs: 1000 })
  r.frame(1)
  r.elements[0].text = 'Real player'
  r.frame(16)
  r.elements[0].y = 40
  r.frame(32)
  r.elements[0].text = 'Updated player'
  r.frame(48)
  const element = r.elements.pop()!
  r.frame(64)
  r.elements.push(element)
  r.frame(80)
  r.frame(120)
  const report = JSON.parse(JSON.stringify(r.posted[0]))
  assert.equal(report.firstContentMs, 16)
  assert.equal(report.settled, true)
  assert.deepEqual(report.events.map((event: { kind: string }) => event.kind), ['rect', 'content', 'disappear', 'appear'])
  assert.equal(report.events[0].before.rect.y, 10)
  assert.equal(report.events[0].after.rect.y, 40)
  assert.equal(report.events[1].after.text, 'Updated player')
  assert.equal(report.requestCount, 0)
})

test('missing meaningful content fails and hidden pages stop sampling', () => {
  const r = recorder()
  r.api.begin({ id: 'missing', expected: { text: 'Absent' }, immediate: true, maximumMs: 100 })
  r.frame(10)
  r.document.hidden = true
  r.handlers.get('visibilitychange')!()
  assert.equal(r.queue.size, 0)
  r.document.hidden = false
  r.handlers.get('visibilitychange')!()
  r.frame(110)
  const metrics = JSON.parse(JSON.stringify(r.posted[0]))
  assert.equal(metrics.firstContentMs, null)
  assert.deepEqual(failures({ metrics }), ['Expected real content did not appear', 'The screen did not settle within the observation window'])
})

test('visible field value changes produce content findings', () => {
  const r = recorder()
  const field = Object.assign(new Element(), { tagName: 'INPUT', value: 'Before' })
  r.elements.push(field)
  r.api.begin({ id: 'field', expected: { text: 'Loading' }, immediate: true })
  r.frame(1)
  field.value = 'After'
  r.frame(16)
  r.api.finish(true)
  const report = JSON.parse(JSON.stringify(r.posted[0]))
  assert.equal(report.events[0].kind, 'content')
  assert.equal(report.events[0].before.text, 'Before')
  assert.equal(report.events[0].after.text, 'After')
})

test('missing reports and Safari tabs cannot produce passing results', () => {
  assert.deepEqual(failures({}), ['No paint recording arrived'])
  assert.deepEqual(failures({ metrics: { standalone: false, settled: true, firstContentMs: 1 } }), ['The page is not an installed Home Screen app'])
})

test('shared stack lock serializes concurrent callers without resetting data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-lock-test-'))
  let active = 0, maximum = 0, visits = 0
  try {
    await Promise.all(Array.from({ length: 3 }, () => lock(path.join(directory, 'shared.lock'), async () => {
      active++; maximum = Math.max(maximum, active); visits++
      await pause(10)
      active--
    })))
    assert.equal(maximum, 1)
    assert.equal(visits, 3)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('cleanup stops its own process and tolerates a second cleanup', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  await stopChild(child)
  assert.equal(child.signalCode, 'SIGTERM')
  await stopChild(child)
})

test('CLI rejects overlapping ports, foreign output paths, and invalid manager slots', () => {
  assert.throws(() => resolveOptions(['--device', 'test', '--port', 'abc']), /port/)
  assert.throws(() => resolveOptions(['--device', 'test', '--port', '58190', '--appium-port', '58190']), /distinct/)
  assert.throws(() => resolveOptions(['--device', 'test', '--port', '58190', '--manager', '10']), /manager/)
  assert.throws(() => resolveOptions(['--device', 'test', '--port', '58190', '--output', process.cwd()]), /outside/)
  assert.throws(() => localUrl('https://example.com'), /loopback/)
  assert.throws(() => localUrl('http://127.0.0.1:54321', 57121), /port/)
})

test('adjacent web ports get separate Appium, agent, and video ports', () => {
  const first = resolveOptions(['--device', 'first', '--port', '58191'])
  const second = resolveOptions(['--device', 'second', '--port', '58192'])
  assert.ok('appiumPort' in first && 'appiumPort' in second)
  const ports = [first.appiumPort, first.appiumPort + 1, first.appiumPort + 2, second.appiumPort, second.appiumPort + 1, second.appiumPort + 2]
  assert.equal(new Set(ports).size, 6)
})

test('stack configuration keeps all service ports separate and disables automatic seeds', () => {
  const config = stackConfig('project_id = "pancake"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = true\n[edge_runtime]\ninspector_port = 8083\n')
  assert.match(config, /project_id = "pancake_ios_shared"/)
  assert.match(config, /port = 57121/)
  assert.match(config, /port = 57122/)
  assert.match(config, /shadow_port = 57120/)
  assert.match(config, /inspector_port = 57183/)
  assert.match(config, /\[db.seed\]\nenabled = false/)
  assert.doesNotMatch(config, /5432[012]/)
})

test('export server resolves player templates, preserves their bytes, and blocks traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ios-server-test-'))
  let server: Awaited<ReturnType<typeof serve>> | undefined
  try {
    await mkdir(path.join(root, 'player'))
    await writeFile(path.join(root, 'player/[id].html'), '<html><head></head><body>Player</body></html>')
    assert.equal(await resolveFile(root, '/player/fixture'), path.join(root, 'player/[id].html'))
    assert.equal(await resolveFile(root, '/../secret'), null)
    assert.equal(await resolveFile(root, '/missing.js'), null)
    server = await serve({ root, port: 0 })
    const address = server.server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetch(`http://127.0.0.1:${address.port}/player/fixture`)
    assert.equal(await response.text(), await readFile(path.join(root, 'player/[id].html'), 'utf8'))
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }) }
})

test('driver rejects W3C command errors instead of treating them as successful clicks', async () => {
  const server = createServer((_request, response) => { response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ value: { error: 'no such element', message: 'Target is absent' } })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const driver = new Driver(address.port)
    await assert.rejects(driver.click('Missing button'), /Target is absent/)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('the source lock covers snapshot through export across two checkouts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-export-test-'))
  try {
    const a = await buildFixture(directory, 'lane-a')
    const b = await buildFixture(directory, 'lane-b')
    const stack = { url: 'http://127.0.0.1:57121', anonKey: 'local-fixture-key' }
    const first = a.build.exportWeb(stack)
    while (!await readFile(path.join(directory, 'shared/export-started')).catch(() => null)) await pause(10)
    const [one, two] = await Promise.all([first, b.build.exportWeb(stack)])
    assert.equal((await readFile(path.join(one.root, '_expo/static/js/web/app.js'), 'utf8')).split('\n').slice(0, 3).join(':'), 'lane-a:lane-a:core-lane-a')
    assert.equal((await readFile(path.join(two.root, '_expo/static/js/web/app.js'), 'utf8')).split('\n').slice(0, 3).join(':'), 'lane-b:lane-b:core-lane-b')
    assert.notEqual(one.hash, two.hash)
    const firstWorker = await readFile(path.join(one.root, 'sw.js'), 'utf8')
    const secondWorker = await readFile(path.join(two.root, 'sw.js'), 'utf8')
    assert.notEqual(firstWorker.match(/const VERSION = '[^']*'/)?.[0], secondWorker.match(/const VERSION = '[^']*'/)?.[0])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the runner rejects a served fingerprint from another checkout or an edited source', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-fingerprint-test-'))
  let server: Awaited<ReturnType<typeof serve>> | undefined
  try {
    const a = await buildFixture(directory, 'lane-a')
    const b = await buildFixture(directory, 'lane-b')
    const stack = { url: 'http://127.0.0.1:57121', anonKey: 'local-fixture-key' }
    const build = await a.build.exportWeb(stack)
    server = await serve({ root: build.root, port: 0 })
    const address = server.server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    await a.build.verifyBuild(origin, build)
    await assert.rejects(b.build.verifyBuild(origin, build), /checkout/)
    await writeFile(path.join(a.checkout, 'screen.tsx'), 'edited')
    await assert.rejects(a.build.verifyBuild(origin, build), /checkout/)
    const metadata = JSON.parse(await readFile(path.join(build.root, 'ios-build.json'), 'utf8'))
    metadata.source = 'foreign-build'
    await writeFile(path.join(build.root, 'ios-build.json'), JSON.stringify(metadata))
    await assert.rejects(a.build.verifyBuild(origin, build), /fingerprint/)
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('an unsettled sign-in and step keep measurements and allow later steps', () => {
  const r = recorder()
  r.api.begin({ id: 'sign-in', expected: { text: 'Loading' }, immediate: true, maximumMs: 100 })
  r.frame(1)
  r.elements[0].y = 30
  r.frame(50)
  r.elements[0].y = 50
  r.frame(110)
  const metrics = JSON.parse(JSON.stringify(r.posted[0]))
  assert.equal(metrics.settled, false)
  assert.equal(metrics.events.length, 2)
  assert.deepEqual(failures({ metrics }), ['The screen did not settle within the observation window'])
  assert.doesNotThrow(() => runner.requireContent({ metrics }))
  r.api.begin({ id: 'later-step', expected: { text: 'Loading' }, immediate: true, minimumMs: 10, quietMs: 5 })
  r.frame(120)
  r.frame(140)
  assert.equal(r.posted.length, 2)
  for (const bad of [{}, { metrics: { ...metrics, firstContentMs: null } }, { metrics: { ...metrics, standalone: false } }]) {
    assert.throws(() => runner.requireContent(bad))
  }
})

test('a deadline flush recovers a hidden page observation before reporting missing data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ios-observation-test-'))
  const server = await serve({ root, port: 0 })
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const stream = await fetch(`${origin}/__ios/control?standalone=1`)
  const reader = stream.body!.getReader()
  try {
    await server.arm({ id: 'hidden', immediate: true })
    const pending = server.result('hidden', 20)
    let messages = ''
    const received = async () => {
      while (!messages.includes('"type":"finish"')) {
        const chunk = await reader.read()
        if (chunk.done) return
        messages += new TextDecoder().decode(chunk.value)
      }
    }
    await Promise.race([received(), pause(800)])
    assert.match(messages, /"type":"finish"/, 'The server must collect the unfinished observation before giving up')
    await fetch(`${origin}/__ios/report`, { method: 'POST', body: JSON.stringify({ id: 'hidden', firstContentMs: 1, standalone: true, settled: false, events: [{ kind: 'rect' }] }) })
    const metrics = await pending
    assert.equal(metrics.events.length, 1)
    const missing = await server.result('disconnected', 20)
    assert.match(missing.observationError, /No paint recording arrived.*disconnected/)
    assert.deepEqual(failures({ metrics: missing }), [missing.observationError])
    await writeReport(root, { steps: [{ id: 'disconnected', metrics: missing }] })
    assert.equal(JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8')).failed, 1)
    assert.ok((await readFile(path.join(root, 'report.md'), 'utf8')).includes(missing.observationError))
  } finally { await reader.cancel(); await server.close(); await rm(root, { recursive: true, force: true }) }
})


test('the recorder retains a failed upload for final collection', async () => {
  const r = recorder(1)
  r.api.begin({ id: 'upload', expected: { text: 'Loading' }, immediate: true, minimumMs: 10, quietMs: 5 })
  r.frame(1)
  r.frame(20)
  await Promise.resolve()
  assert.equal(r.posted.length, 0)
  r.message({ type: 'finish', id: 'upload' })
  await Promise.resolve()
  assert.equal(r.posted.length, 1)
  assert.equal(r.posted[0].id, 'upload')
  assert.equal(r.posted[0].firstContentMs, 1)
})

test('sampling errors produce a failed observation with a reason', () => {
  const r = recorder()
  r.api.begin({ id: 'sampling', expected: { text: 'Loading' }, immediate: true })
  r.document.querySelectorAll = () => { throw new Error('Broken selector') }
  assert.doesNotThrow(() => r.frame(1))
  const metrics = JSON.parse(JSON.stringify(r.posted[0]))
  assert.match(metrics.observationError, /Recorder sampling failed: Broken selector/)
  assert.ok(failures({ metrics }).includes(metrics.observationError))
})


test('resetting sign-in removes stale PWA shells before loading the requested page', async () => {
  const r = recorder()
  await r.message({ type: 'reset-auth', url: '/sign-in' })
  assert.deepEqual(r.resetEvents, ['unregister', 'pancake-old-public-shell', '/sign-in'])
})

test('only the installed page with the requested source fingerprint can measure steps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ios-page-build-test-'))
  await writeFile(path.join(root, 'ios-build.json'), JSON.stringify({ source: 'current-source', hash: 'fixture-build' }))
  await mkdir(path.join(root, '_expo/static/js/web'), { recursive: true })
  await writeFile(path.join(root, '_expo/static/js/web/entry.js'), 'const route="/_expo/static/js/web/league.js"; const remote="https://example.invalid/assets/photo.png"')
  await writeFile(path.join(root, 'index.html'), '<html><head><meta name="pancake-release" content="pancake-build"><script src="/_expo/static/js/web/entry.js"></script></head></html>')
  const server = await serve({ root, port: 0 })
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const stale = await fetch(`${origin}/__ios/control?standalone=1&source=old-source`)
  let current: Response | undefined
  try {
    assert.equal(server.connected(), 1)
    assert.equal(server.verified(), 0)
    const html = await (await fetch(origin)).text()
    assert.equal(html, await readFile(path.join(root, 'index.html'), 'utf8'))
    const script = await (await fetch(`${origin}/_expo/static/js/web/entry.js`)).text()
    assert.equal(script, await readFile(path.join(root, '_expo/static/js/web/entry.js'), 'utf8'))
    assert.ok(script.includes('https://example.invalid/assets/photo.png'))
    assert.equal((await fetch(`${origin}/__ios/build/foreign/_expo/static/js/web/entry.js`)).status, 404)
    const rejected = await fetch(`${origin}/__ios/report`, { method: 'POST', body: JSON.stringify({ id: 'stale', sourceFingerprint: 'old-source' }) })
    assert.equal(rejected.status, 400)
    assert.match(await rejected.text(), /fingerprint/)
    current = await fetch(`${origin}/__ios/control?standalone=1&source=current-source`)
    assert.equal(server.verified(), 1)
    const accepted = await fetch(`${origin}/__ios/report`, { method: 'POST', body: JSON.stringify({ id: 'current', sourceFingerprint: 'current-source' }) })
    assert.equal(accepted.status, 204)
    assert.equal((await server.result('current', 20)).sourceFingerprint, 'current-source')
    server.resetAuth('/sign-in')
    assert.equal(server.verified(), 0)
  } finally { await stale.body?.cancel(); await current?.body?.cancel(); await server.close(); await rm(root, { recursive: true, force: true }) }
})


test('namespaced build assets remain part of the measured request count', async () => {
  const r = recorder()
  r.api.begin({ id: 'assets', expected: { text: 'Loading' }, immediate: true, minimumMs: 10, quietMs: 5 })
  r.frame(1)
  await r.fetch('http://127.0.0.1:58190/__ios/build/current/_expo/chunk.js', {})
  await r.fetch('http://127.0.0.1:58190/__ios/control', {})
  r.frame(20)
  assert.equal(r.posted[0].requestCount, 1)
})


test('exports to different local stacks stay separate when their public keys match', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-stack-build-test-'))
  try {
    const a = await buildFixture(directory, 'same-source-a')
    const b = await buildFixture(directory, 'same-source-b', 'http://127.0.0.1:57621')
    for (const file of ['screen.tsx', 'core/index.ts']) await writeFile(path.join(b.checkout, file), await readFile(path.join(a.checkout, file)))
    const first = await a.build.exportWeb({ url: 'http://127.0.0.1:57121', anonKey: 'same-local-key' })
    const second = await b.build.exportWeb({ url: 'http://127.0.0.1:57621', anonKey: 'same-local-key' })
    assert.equal(first.sourceFingerprint, second.sourceFingerprint)
    assert.notEqual(first.hash, second.hash)
    assert.notEqual(first.root, second.root)
    assert.equal(JSON.parse(await readFile(path.join(second.root, 'ios-build.json'), 'utf8')).stackUrl, 'http://127.0.0.1:57621')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('return waits for native idleness and restores the prior driver setting on failure', async () => {
  const calls: { route: string, body?: any }[] = []
  const driver = {
    native: async () => {},
    request: async (method: string, route: string, body?: any) => {
      calls.push({ route, body })
      if (method === 'GET' && route === '/appium/settings') return { waitForIdleTimeout: 0 }
      if (route === '/source') throw new Error('Lost foreground app')
    },
  }
  await assert.rejects(runner.waitForNativeTransition(driver), /Lost foreground app/)
  assert.deepEqual(calls.slice(1).map(call => [call.route, call.body]), [
    ['/appium/settings', { settings: { waitForIdleTimeout: 5 } }],
    ['/source', undefined],
    ['/appium/settings', { settings: { waitForIdleTimeout: 0 } }],
  ])
})

test('a late native password prompt is dismissed before retrying the intended tap', async () => {
  const clicks: string[] = []
  const missing = new Error('The intended control is blocked')
  let source = '<XCUIElementTypeAlert name="Save Password?" />'
  const driver = {
    click: async (label: string) => {
      clicks.push(label)
      if (clicks.length === 1) throw missing
    },
    request: async () => source,
  }
  await runner.clickThroughPasswordPrompt(driver, 'Light')
  assert.deepEqual(clicks, ['Light', 'Never for This Website', 'Light'])
  clicks.length = 0
  source = '<XCUIElementTypeApplication />'
  await assert.rejects(runner.clickThroughPasswordPrompt(driver, 'Missing'), error => error === missing)
  assert.deepEqual(clicks, ['Missing'])
})

test('native picker options stay native while web taps wait for the full DOM label', async () => {
  const calls: string[] = []
  const native = { native: async () => { calls.push('native') }, click: async (label: string) => { calls.push(label) }, optional: async (label: string) => { calls.push(label) } }
  await runner.selectNativeOption(native, '2025–26')
  assert.deepEqual(calls, ['native', '2025–26', 'Done'])
  const labels = [null, 'Monday, October 19']
  let reads = 0
  const web = { execute: async () => labels[reads++] }
  assert.equal(await runner.visibleTapLabel(web, 'Monday, ', true), 'Monday, October 19')
  assert.equal(reads, 2)
}, 1000)

test('preparing the same route waits for its new document before allowing a tap', async () => {
  const page = { timeOrigin: 1, route: '/', ready: 'complete', text: 'Previous ready matchup content' }
  let navigating = false, checks = 0
  const driver = {
    web: async () => {},
    execute(source: string, route: string, previousDocument: number) {
      if (navigating) {
        checks++
        if (checks === 2) Object.assign(page, { timeOrigin: 2, ready: 'loading', text: '' })
        if (checks === 3) Object.assign(page, { ready: 'complete', text: 'New matchup ready for input' })
      }
      return vm.runInNewContext(`(function () { ${source} }).apply(null, args)`, {
        args: [route, previousDocument], URL, performance: { timeOrigin: page.timeOrigin },
        location: { href: 'http://127.0.0.1:58241/', pathname: page.route, search: '' },
        document: { readyState: page.ready, getElementById: () => ({ innerText: page.text }) },
      })
    },
  }
  const server = { network() {}, prepare() { navigating = true } }
  await runner.prepareScenarioPage(server, driver, 'http://127.0.0.1:58241', '/', true)
  assert.equal(page.timeOrigin, 2)
  assert.equal(page.ready, 'complete')
  assert.equal(page.text, 'New matchup ready for input')
})

test('a capture can select its own local stack without changing the shared stack', () => {
  const options = resolveOptions(['--device', 'own-device', '--port', '58243', '--manager', '2', '--stack-dir', '/private/tmp/own-stack'])
  assert.ok('stack-dir' in options)
  assert.equal(options['stack-dir'], '/private/tmp/own-stack')
})

test('an exact web tap waits for its control instead of falling through to an early native tap', async () => {
  const labels = [null, 'Open menu']
  let reads = 0
  const driver = { execute: async () => labels[reads++] }
  assert.equal(await runner.visibleTapLabel(driver, 'Open menu'), 'Open menu')
  assert.equal(reads, 2)
}, 1000)


test('stack refresh removes deleted migrations and functions before copying the checkout', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-stack-copy-'))
  try {
    for (const root of ['source', 'stack']) for (const name of ['migrations', 'functions']) {
      await mkdir(path.join(directory, root, 'supabase', name), { recursive: true })
      await writeFile(path.join(directory, root, 'supabase', name, root === 'source' ? 'current.sql' : 'stale.sql'), 'SELECT 1;')
    }
    await copyStackSources(path.join(directory, 'source'), path.join(directory, 'stack'))
    for (const name of ['migrations', 'functions']) {
      await assert.rejects(readFile(path.join(directory, 'stack', 'supabase', name, 'stale.sql')), { code: 'ENOENT' })
      assert.equal(await readFile(path.join(directory, 'stack', 'supabase', name, 'current.sql'), 'utf8'), 'SELECT 1;')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test.each(['minutes', 'seconds'].flatMap(format => [false, true].map(moved => ({ format, moved }))))('clock digits settle only when allowed and their box stays fixed: $format $moved', ({ format, moved }) => {
  const r = recorder()
  r.elements[0].text = format === 'minutes' ? '01:00' : '3600 s'
  r.api.begin({ id: 'clock', expected: { text: format === 'minutes' ? ':' : ' s' }, allowClock: true, immediate: true, minimumMs: 3500, quietMs: 1200, maximumMs: 4000 })
  r.frame(1)
  for (let i = 1; i <= 4; i++) {
    r.elements[0].text = format === 'minutes' ? `00:${60 - i}` : `${3600 - i} s`
    if (moved) r.elements[0].y += 1
    r.frame(i * 1000)
  }
  r.frame(4001)
  const result = r.posted[0] as { settled: boolean; events: { kind: string }[] }
  assert.equal(result.settled, !moved)
  assert.ok(result.events.some(event => event.kind === (moved ? 'rect' : 'clock')))
})

test('a reused PWA refreshes its cached HTML before waiting for a recorder connection', async () => {
  const events: string[] = []
  const performance = { timeOrigin: 1 }
  const browser = {
    performance, document: { readyState: 'complete' },
    localStorage: { clear: () => events.push('auth') },
    sessionStorage: { clear: () => events.push('session') },
    navigator: { serviceWorker: { getRegistrations: async () => [{ unregister: async () => events.push('unregister') }] } },
    caches: { keys: async () => ['pancake-old-shell', 'unrelated'], delete: async (name: string) => events.push(name) },
    location: { replace: (url: string) => { events.push(url); performance.timeOrigin = 2 } },
  }
  const driver = {
    web: async () => true,
    execute: async (script: string, ...args: unknown[]) => vm.runInNewContext(`(function() { ${script} }).apply(null, supplied)`, { ...browser, supplied: args }),
  }
  await runner.refreshInstalledPage(driver, 'http://127.0.0.1:57331')
  assert.deepEqual(events, ['auth', 'session', 'unregister', 'pancake-old-shell', 'http://127.0.0.1:57331/sign-in'])
})

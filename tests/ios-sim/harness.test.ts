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
import { failures } from '../../scripts/ios-sim/report.mjs'
import { resolveOptions } from '../../scripts/ios-sim/run.mjs'
import { resolveFile, serve } from '../../scripts/ios-sim/server.mjs'
import { stackConfig } from '../../scripts/ios-sim/stack.mjs'

class Element {
  tagName = 'DIV'
  text = 'Loading'
  y = 10
  get childNodes() { return [{ nodeType: 3, textContent: this.text }] }
  getBoundingClientRect() { return { x: 10, y: this.y, width: 100, height: 20, top: this.y, left: 10, bottom: this.y + 20, right: 110 } }
  getAttribute(name: string) { return name === 'role' ? 'heading' : null }
}

function recorder() {
  let now = 0, counter = 0
  const queue = new Map<number, () => void>()
  const posted: Record<string, unknown>[] = []
  const elements = [new Element()]
  const handlers = new Map<string, () => void>()
  const storage = new Map()
  const document = { hidden: false, documentElement: {}, querySelectorAll: () => elements, addEventListener: (event: string, callback: () => void) => handlers.set(event, callback) }
  const context = {
    document, navigator: { standalone: true }, innerWidth: 402, innerHeight: 812,
    location: { href: 'http://127.0.0.1:58190/', pathname: '/', search: '' },
    performance: { now: () => now, timeOrigin: 0 }, Date: { now: () => now },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (callback: () => void) => { queue.set(++counter, callback); return counter },
    cancelAnimationFrame: (id: number) => queue.delete(id),
    MutationObserver: class { observe() {} disconnect() {} },
    EventSource: class { close() {} },
    XMLHttpRequest: class { open() {} send() {} },
    fetch: async (_url: string, options: { body?: string }) => { if (options?.body) posted.push(JSON.parse(options.body)); return {} },
  }
  const scope = vm.createContext({ ...context, window: context })
  vm.runInContext(recorderSource, scope)
  const api = (context as typeof context & { __iosRecorder: { begin: (spec: object) => void, finish: (settled: boolean) => unknown } }).__iosRecorder
  const frame = (time: number) => { now = time; const jobs = [...queue.values()]; queue.clear(); for (const job of jobs) job() }
  return { api, frame, elements, posted, handlers, document, queue }
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

test('export server resolves player templates, injects the recorder, and blocks traversal', async () => {
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
    assert.match(await response.text(), /<head><script src="\/__ios\/recorder.js"><\/script>/)
    assert.equal((await readFile(path.join(root, 'player/[id].html'), 'utf8')).includes('__ios'), false)
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

import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'vitest'
import { serve } from '../../scripts/ios-sim/server.mjs'
import { buildFixture } from './build-fixture.mjs'

test('the exported worker installs and claims the exact bytes served by the harness', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-worker-export-'))
  let server: Awaited<ReturnType<typeof serve>> | undefined
  try {
    const fixture = await buildFixture(directory, 'worker')
    const build = await fixture.build.exportWeb({ url: 'http://127.0.0.1:57121', anonKey: 'local-key' })
    server = await serve({ root: build.root, port: 0 })
    const address = server.server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const html = await (await fetch(origin)).text()
    const listeners = new Map<string, (event: { waitUntil: (pending: Promise<unknown>) => void }) => void>()
    const stores = new Map<string, Map<string, Response>>()
    let claimed = false, installed = false
    class WorkerRequest extends Request {
      constructor(input: string | Request, init?: RequestInit) { super(typeof input === 'string' ? new URL(input, origin) : input, init) }
    }
    const caches = {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map())
        const store = stores.get(name)!
        return { match: async (url: string) => store.get(url)?.clone(), put: async (url: string, response: Response) => store.set(url, response.clone()) }
      },
    }
    vm.runInNewContext(await readFile(path.join(build.root, 'sw.js'), 'utf8'), {
      self: { location: { origin }, addEventListener: (type: string, callback: any) => listeners.set(type, callback), skipWaiting: async () => { installed = true }, clients: { matchAll: async () => [], claim: async () => { claimed = true } } },
      caches, fetch, Request: WorkerRequest, Response, URL, crypto: webcrypto, AbortController, setTimeout, clearTimeout,
    })
    for (const type of ['install', 'activate']) {
      const pending: Promise<unknown>[] = []
      listeners.get(type)!({ waitUntil: promise => pending.push(promise) })
      await Promise.all(pending)
    }
    assert.ok(installed && claimed)
    assert.equal(html, await readFile(path.join(build.root, 'index.html'), 'utf8'))
    assert.match(html, /name="ios-source-fingerprint"/)
    assert.match(html, /\/assets\/ios-recorder\.[a-f0-9]+\.js/)
    assert.ok([...stores.values()].some(store => store.has('/')))
    for (const store of stores.values()) for (const [url, cached] of store) {
      const file = path.join(build.root, url === '/' ? 'index.html' : url)
      assert.deepEqual(Buffer.from(await cached.arrayBuffer()), await readFile(file))
    }
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a lifecycle step requires a controlling worker from the served origin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ios-worker-control-'))
  const server = await serve({ root, port: 0 })
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    for (const [index, worker] of ['', 'https://example.invalid/sw.js', `${origin}/sw.js`].entries()) {
      const id = `lifecycle-${index}`
      server.arm({ id, requireWorker: true })
      await fetch(`${origin}/__ios/ack?id=${id}&worker=${encodeURIComponent(worker)}`, { method: 'POST' })
      if (index < 2) await assert.rejects(server.armed(id, 100), /controlling service worker/)
      else await server.armed(id, 100)
    }
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
})

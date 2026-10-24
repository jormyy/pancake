import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pause, readJson } from './common.mjs'

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }

export async function resolveFile(root, pathname) {
  const decoded = decodeURIComponent(pathname)
  const safe = path.resolve(root, `.${decoded}`)
  if (safe !== root && !safe.startsWith(`${root}/`)) return null
  const candidates = [safe, `${safe}.html`, path.join(safe, 'index.html')]
  const parent = path.dirname(safe)
  const dynamic = (await readdir(parent).catch(() => [])).find(file => /^\[[^.[\]]+\]\.html$/.test(file))
  if (dynamic) candidates.push(path.join(parent, dynamic))
  if (!path.extname(decoded)) candidates.push(path.join(root, '+not-found.html'))
  for (const candidate of candidates) if ((await stat(candidate).catch(() => null))?.isFile()) return candidate
  return null
}

export async function serve({ root, port }) {
  const build = await readJson(path.join(root, 'ios-build.json'))
  const controls = new Map(), reports = new Map(), acknowledgments = new Map()
  let current, offline = false
  const matches = source => !build || source === build.source
  const send = message => { for (const [stream, source] of controls) if (message.type !== 'begin' || matches(source)) stream.write(`data: ${JSON.stringify(message)}\n\n`) }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`)
      if (url.pathname === '/__ios/control') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        response.write(': connected\n\n')
        if (url.searchParams.get('standalone') === '1') controls.set(response, url.searchParams.get('source'))
        if (current && url.searchParams.get('standalone') === '1' && matches(url.searchParams.get('source'))) response.write(`data: ${JSON.stringify({ type: 'begin', spec: current })}\n\n`)
        request.once('close', () => controls.delete(response))
        return
      }
      if (url.pathname === '/__ios/ack' && request.method === 'POST') {
        acknowledgments.set(url.searchParams.get('id'), url.searchParams.get('worker'))
        response.writeHead(204); response.end(); return
      }
      if (url.pathname === '/__ios/report' && request.method === 'POST') {
        let body = ''
        for await (const chunk of request) { body += chunk; assert.ok(body.length < 16000000, 'Report is too large') }
        const report = JSON.parse(body)
        assert.ok(matches(report.sourceFingerprint), 'Installed page source fingerprint differs from the served build')
        if (!reports.has(report.id)) reports.set(report.id, report)
        response.writeHead(204); response.end(); return
      }
      if (offline) { response.destroy(); return }
      const file = await resolveFile(root, url.pathname)
      if (!file) { response.writeHead(404); response.end('Not found'); return }
      const extension = path.extname(file)
      response.writeHead(200, { 'content-type': types[extension] ?? 'application/octet-stream', 'cache-control': file.includes('/_expo/static/') || file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate' })
      createReadStream(file).pipe(response)
    } catch (error) { if (!response.headersSent) response.writeHead(400); response.end(error.message) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(undefined)) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const workerUrl = `http://127.0.0.1:${address.port}/sw.js`
  return {
    server, reports,
    arm(spec) { acknowledgments.delete(spec.id); reports.delete(spec.id); current = { ...spec, startedAt: Date.now() }; send({ type: 'begin', spec: current }); return current },
    disarm() { current = null; send({ type: 'finish' }) },
    prepare(url) { current = null; send({ type: 'prepare', url }) },
    navigate(url) { send({ type: 'prepare', url }) },
    resetAuth(url) { current = null; for (const stream of controls.keys()) controls.set(stream, null); send({ type: 'reset-auth', url }) },
    blur() { send({ type: 'blur' }) },
    offline(value) { offline = value },
    network(value) { send({ type: 'offline', value }) },
    connected() { return controls.size },
    verified() { return [...controls.values()].filter(matches).length },
    async armed(id, timeout = 5000) {
      const started = Date.now()
      while (Date.now() - started < timeout) {
        if (acknowledgments.has(id)) {
          if (current?.id === id && current.requireWorker) assert.equal(acknowledgments.get(id), workerUrl, 'Lifecycle steps require a controlling service worker from this export')
          return
        }
        await pause(50)
      }
      throw new Error(`Recorder did not acknowledge observation ${id}`)
    },
    async result(id, timeout = 16000) {
      const wait = async duration => {
        const started = Date.now()
        while (Date.now() - started < duration) { if (reports.has(id)) return reports.get(id); await pause(50) }
        return null
      }
      const observed = await wait(timeout)
      if (observed) return observed
      send({ type: 'finish', id, reason: 'Recorder exceeded the observation deadline' })
      return await wait(2000) ?? { id, missingObservation: true, observationError: `No paint recording arrived for ${id} after the observation deadline and final collection attempt (${controls.size} recorder connections)`, firstContentMs: null, events: [] }
    },
    async close() { for (const stream of controls.keys()) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}

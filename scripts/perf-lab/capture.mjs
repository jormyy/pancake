import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { appendFile } from './bounded-log.mjs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import WebSocket, { WebSocketServer } from 'ws'
import { labRoot, localTarget, ports, publicUrl, safeHeaders } from './common.mjs'

import { readSleeperHeadshot } from './external-headshots.mjs'

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

export function summarizeAccess(rows) {
  return rows.reduce((total, row) => ({ requests: total.requests + 1, bytesIn: total.bytesIn + row.bytesOut, bytesOut: total.bytesOut + row.bytesIn, errors: total.errors + Number(row.status >= 400) }), { requests: 0, bytesIn: 0, bytesOut: 0, errors: 0 })
}

function realtimeMetadata(data, direction) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  let payload
  try { payload = JSON.parse(bytes.toString()) } catch { payload = null }
  return { direction, bytes: bytes.length, channel: payload?.topic ?? (Array.isArray(payload) ? payload[2] : null), event: payload?.event ?? (Array.isArray(payload) ? payload[3] : null) }
}

export async function captureServer({ root, evidence, key = undefined, cert = undefined, port = ports.https, apiPort = ports.api, edgePort = ports.edge, host = '127.0.0.1' }) {
  assert.ok([port, apiPort, edgePort].every(value => Number.isInteger(value) && Math.floor(value / 100) === Math.floor(ports.api / 100)), 'Use only the private capture ports')
  assert.ok(host === '127.0.0.1' || host === '0.0.0.0' && process.env.PERF_LAB_ALLOW_LAN === '1', 'LAN gateway requires its explicit grant')
  const rootPath = await realpath(root)
  const accessRows = [], realtimeRows = [], errors = []
  let writes = Promise.resolve()
  const record = (file, row) => {
    writes = writes.then(() => appendFile(path.join(evidence, file), `${JSON.stringify(row)}\n`, { mode: 0o600 })).catch(error => { if (!errors.length) errors.push(error.message) })
  }
  let window = 'unassigned', fault = null
  const handler = async (request, response) => {
    const started = performance.now(), startedAt = Date.now()
    let bytesIn = 0, bytesOut = 0, upstreamHeaders = {}, injected = false
    request.on('data', data => { bytesIn += data.length })
    const end = response.end.bind(response)
    const write = response.write.bind(response)
    response.write = (chunk, ...args) => { if (chunk) bytesOut += Buffer.byteLength(chunk); return write(chunk, ...args) }
    response.end = (chunk, ...args) => { if (chunk) bytesOut += Buffer.byteLength(chunk); return end(chunk, ...args) }
    const requestWindow = window
    response.on('finish', () => {
      const row = { window: requestWindow, startedAt, method: request.method, url: publicUrl(`http://127.0.0.1:${port}${request.url}`), status: response.statusCode, injected, bytesIn, bytesOut, durationMs: performance.now() - started, requestHeaders: safeHeaders(request.headers), responseHeaders: safeHeaders(upstreamHeaders) }
      accessRows.push(row)
      record('access.jsonl', row)
    })
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`)
      if (fault && (fault === requestWindow || requestWindow.startsWith(`${fault}/`)) && /^\/(?:backend\/)?(?:rest|functions)\/v1\//.test(url.pathname)) {
        injected = true
        upstreamHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' }
        response.writeHead(503, upstreamHeaders)
        response.end(JSON.stringify({ error: 'Performance lab refresh failure' }))
        return
      }
      if (url.pathname.startsWith('/backend/') || /^\/(auth|rest|functions|storage|realtime)\/v1\//.test(url.pathname)) {
        const targetPath = (url.pathname.startsWith('/backend/') ? url.pathname.slice('/backend'.length) : url.pathname) + url.search
        const targetPort = targetPath.startsWith('/functions/v1/') ? edgePort : apiPort
        const target = localTarget(`http://127.0.0.1:${targetPort}${targetPath}`, [apiPort, edgePort])
        const headers = { ...request.headers, host: target.host }
        delete headers.connection
        const upstream = http.request(target, { method: request.method, headers }, incoming => {
          upstreamHeaders = incoming.headers
          response.writeHead(incoming.statusCode, incoming.headers)
          incoming.on('error', () => response.destroy())
          incoming.pipe(response)
        })
        upstream.on('error', () => { response.writeHead(502); response.end('Local upstream unavailable') })
        request.pipe(upstream)
        return
      }
      assert.ok(['GET', 'HEAD'].includes(request.method), 'Static content is read-only')
      const image = /^\/__lab\/headshots\/sleeper\/(\d{1,10})$/.exec(url.pathname)
      if (image) {
        const asset = await readSleeperHeadshot(path.join(labRoot, 'fixtures/headshots'), image[1])
        upstreamHeaders = asset.headers
        if (asset.headers.etag && request.headers['if-none-match'] === asset.headers.etag) { response.writeHead(304, asset.headers); response.end(); return }
        response.writeHead(asset.status, asset.headers)
        response.end(request.method === 'HEAD' ? undefined : asset.body)
        return
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const candidates = path.extname(relative) ? [relative] : [relative || 'index.html', `${relative}.html`, `${relative}/index.html`, 'index.html']
      let file
      for (const candidate of candidates) {
        const absolute = path.resolve(rootPath, candidate)
        assert.ok(absolute.startsWith(`${rootPath}/`), 'Path escapes the export')
        try {
          if ((await stat(absolute)).isFile()) {
            assert.ok((await realpath(absolute)).startsWith(`${rootPath}/`), 'Symlink escapes the export')
            file = absolute
            break
          }
        } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
      }
      if (!file) { response.writeHead(404); response.end('Export file is missing'); return }
      upstreamHeaders = { 'content-type': contentTypes[path.extname(file)] ?? 'application/octet-stream', 'cache-control': /\/(?:assets|_expo)\//.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate' }
      response.writeHead(200, upstreamHeaders)
      if (request.method === 'HEAD') response.end()
      else createReadStream(file).pipe(response)
    } catch { response.writeHead(400); response.end('Invalid local request') }
  }
  const server = key && cert ? https.createServer({ key: await readFile(key), cert: await readFile(cert) }, handler) : http.createServer(handler)
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  const websocketServer = new WebSocketServer({ noServer: true })
  const websocketClients = new Set()
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    if (!url.pathname.startsWith('/backend/realtime/') && !url.pathname.startsWith('/realtime/')) { socket.destroy(); return }
    websocketServer.handleUpgrade(request, socket, head, client => {
      const upstream = new WebSocket(`ws://127.0.0.1:${apiPort}${url.pathname.startsWith('/backend/') ? url.pathname.slice('/backend'.length) : url.pathname}${url.search}`)
      websocketClients.add(client)
      websocketClients.add(upstream)
      const pending = []
      const emit = (data, direction) => { const row = { window, ...realtimeMetadata(data, direction), at: Date.now() }; realtimeRows.push(row); record('realtime.jsonl', row) }
      upstream.on('open', () => { for (const [data, binary] of pending) upstream.send(data, { binary }) })
      client.on('message', (data, binary) => { emit(data, 'out'); if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); else pending.push([data, binary]) })
      upstream.on('message', (data, binary) => { emit(data, 'in'); if (client.readyState === WebSocket.OPEN) client.send(data, { binary }) })
      for (const peer of [client, upstream]) {
        peer.on('error', () => { client.terminate(); upstream.terminate() })
        peer.on('close', () => { websocketClients.delete(peer); client.terminate(); upstream.terminate() })
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(undefined)) })
  return {
    origin: `${key && cert ? 'https' : 'http'}://127.0.0.1:${port}`,
    mark(id) { window = id },
    failRefresh(id) { fault = id },
    clearFault() { fault = null },
    rows(id) { return { access: accessRows.filter(row => row.window === id || row.window.startsWith(`${id}/`)), realtime: realtimeRows.filter(row => row.window === id || row.window.startsWith(`${id}/`)) } },
    async close() {
      for (const peer of websocketClients) peer.terminate()
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      await writes
      assert.equal(errors.length, 0, `Capture writes failed: ${errors.join('; ')}`)
    },
  }
}

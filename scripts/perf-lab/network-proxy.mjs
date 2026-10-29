import { ports, target as lab } from './common.mjs'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

export async function networkProxy(origin, port = ports.proxy) {
  const target = new URL(origin)
  assert.ok(['http:', 'https:'].includes(target.protocol))
  assert.equal(target.username, '')
  assert.equal(target.password, '')
  assert.equal(target.pathname, '/')
  assert.equal(target.search, '')
  assert.equal(target.hash, '')
  assert.match(target.hostname, /^(?:[a-z0-9-]+\.local|localhost|127\.0\.0\.1)$/)
  assert.ok(Number(target.port) >= Number(lab.prefix) * 100 && Number(target.port) <= Number(lab.prefix) * 100 + 99)
  assert.ok(Number.isInteger(port) && port >= Number(lab.prefix) * 100 && port <= Number(lab.prefix) * 100 + 99)
  const blocked = [], sockets = new Set()
  const allowed = url => url.hostname === target.hostname && url.port === target.port && !url.username && !url.password
  const reject = (socket, host) => { blocked.push({ host, at: Date.now() }); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n') }
  const server = http.createServer((request, response) => {
    let url
    try { url = new URL(request.url) } catch { response.writeHead(400); response.end(); return }
    if (!allowed(url) || target.protocol !== 'http:') { blocked.push({ host: url.host, at: Date.now() }); response.writeHead(403); response.end(); return }
    const upstream = http.request({ hostname: '127.0.0.1', port: target.port, path: url.pathname + url.search, method: request.method,
      headers: { ...request.headers, host: target.host } }, incoming => { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response) })
    upstream.on('error', () => { response.writeHead(502); response.end() })
    request.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('connect', (request, client, head) => {
    let url
    try { url = new URL(`https://${request.url}`) } catch { reject(client, 'invalid'); return }
    if (!allowed(url) || target.protocol !== 'https:') { reject(client, url.host); return }
    const upstream = net.connect({ host: '127.0.0.1', port: Number(target.port) })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  })
  await new Promise((resolve, rejectStart) => { server.once('error', rejectStart); server.listen(port, '127.0.0.1', () => resolve(undefined)) })
  return { url: `http://127.0.0.1:${port}`, blocked,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}

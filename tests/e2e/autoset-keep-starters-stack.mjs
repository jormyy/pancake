import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withDatabase } from '../../scripts/perf-lab/setup.mjs'
import { certificate } from '../../scripts/perf-lab/build.mjs'
import { startEdge } from '../../scripts/perf-lab/runtime.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { labRoot, project, ports, json } from '../../scripts/perf-lab/common.mjs'

assert.equal(project, 'pt4bafableas')
assert.equal(ports.api, 64021)
const tls = await certificate()
await withDatabase(async ({ evidence }) => {
    const edge = await startEdge(evidence)
    const sockets = new Set()
    const forward = (request, response) => {
        const port = request.url.startsWith('/functions/v1/') ? ports.edge : ports.api
        const upstream = http.request({ hostname: '127.0.0.1', port, path: request.url, method: request.method, headers: request.headers }, incoming => {
            response.writeHead(incoming.statusCode, incoming.headers)
            incoming.pipe(response)
        })
        upstream.on('error', () => { response.writeHead(502); response.end() })
        request.pipe(upstream)
    }
    const server = https.createServer({ key: await readFile(tls.key), cert: await readFile(tls.cert) }, async (request, response) => {
        if (/^\/(auth|rest|realtime|storage|functions)\/v1\//.test(request.url)) return forward(request, response)
        const pathname = decodeURIComponent(new URL(request.url, tls.origin).pathname)
        if (pathname.includes('..')) { response.writeHead(400); response.end(); return }
        const file = path.join(process.cwd(), 'dist', pathname)
        const bytes = await readFile(file).catch(() => readFile('dist/index.html'))
        const extension = path.extname(file)
        response.setHeader('content-type', ({ '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' })[extension] ?? 'text/html')
        response.setHeader('cache-control', 'no-store')
        response.end(bytes)
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    server.on('upgrade', (request, socket, head) => {
        const upstream = http.request({ hostname: '127.0.0.1', port: ports.api, path: request.url, headers: request.headers })
        upstream.on('upgrade', (incoming, peer, bytes) => {
            socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(incoming.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
            peer.write(head); socket.write(bytes); peer.pipe(socket); socket.pipe(peer)
        })
        upstream.on('error', () => socket.destroy())
        upstream.end()
    })
    try {
        console.log('Building the private auto-set browser artifact.')
        await command('node', ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--clear'], { timeout: 240000, env: { ...process.env, EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', EXPO_PUBLIC_SUPABASE_URL: tls.origin, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: edge.keys.ANON_KEY } })
        await new Promise(resolve => server.listen(ports.https, '0.0.0.0', () => resolve(undefined)))
        await json(path.join(labRoot, 'browser-origin.json'), { origin: tls.origin })
        console.log(`Auto-set stack ready: ${tls.origin}`)
        while (await access(path.join(labRoot, 'stop')).then(() => false, () => true)) await delay(1000)
    } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise(resolve => server.close(resolve))
        await edge.close()
    }
})

import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { appendFileSync } from 'node:fs'
import path from 'node:path'

export async function trafficProxy(directory) {
    const sockets = new Set()
    const resolve = request => {
        const url = new URL(request.url, `http://${request.headers.host}`)
        if (!['http:', 'ws:'].includes(url.protocol) || !/^(127\.0\.0\.1|localhost|[a-z0-9-]+\.localhost)$/.test(url.hostname) || !/^649\d\d$/.test(url.port)) throw new Error('Only this private port block is allowed')
        const port = url.port === '64921' && url.pathname.startsWith('/functions/v1/') ? 64981 : Number(url.port)
        return { hostname: '127.0.0.1', port, path: url.pathname + url.search, method: request.method, headers: request.headers }
    }
    const server = http.createServer((request, response) => {
        appendFileSync(path.join(directory, 'proxy-paths.jsonl'), `${JSON.stringify({ at: Date.now(), host: request.headers.host, path: new URL(request.url, 'http://localhost').pathname })}\n`)
        let target
        try { target = resolve(request) } catch { response.writeHead(403); response.end(); return }
        const began = Date.now()
        const body = createHash('sha256').update(`${request.method} ${request.url}`)
        request.on('data', bytes => body.update(bytes))
        const upstream = http.request(target, incoming => {
            const chunks = []
            response.writeHead(incoming.statusCode, incoming.headers)
            incoming.on('data', bytes => chunks.push(bytes))
            incoming.on('end', () => {
                if (target.port !== 64921 && target.port !== 64981) return
                const encoded = Buffer.concat(chunks)
                const decoded = incoming.headers['content-encoding'] === 'br' ? brotliDecompressSync(encoded) : incoming.headers['content-encoding'] === 'gzip' ? gunzipSync(encoded) : encoded
                const headers = incoming.rawHeaders.reduce((value, field, index) => value + field + (index % 2 ? '\r\n' : ': '), '')
                const transfer = encoded.length + Buffer.byteLength(`HTTP/${incoming.httpVersion} ${incoming.statusCode} ${incoming.statusMessage}\r\n${headers}\r\n`)
                appendFileSync(path.join(directory, 'api-transfer.jsonl'), `${JSON.stringify({ at: began, origin: request.headers.origin, endpoint: new URL(request.url).pathname, method: request.method, signature: body.digest('hex'), transfer, decoded: decoded.length, status: incoming.statusCode, target: 'supabase' })}\n`)
            })
            incoming.pipe(response)
        })
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
        request.on('aborted', () => upstream.destroy())
        request.pipe(upstream)
    })
    server.on('connect', (request, socket, head) => {
        let target
        try { target = resolve({ url: `http://${request.url}`, method: 'CONNECT', headers: request.headers }) } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
        let headers = Buffer.alloc(0)
        let origin
        const peer = net.connect(target.port, target.hostname, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) peer.write(head)
            socket.pipe(peer)
            peer.pipe(socket)
        })
        socket.on('data', bytes => {
            if (origin || headers.length >= 32768) return
            headers = Buffer.concat([headers, bytes])
            if (headers.includes('\r\n\r\n')) origin = headers.toString().match(/\r\nOrigin: ([^\r\n]+)/i)?.[1]
        })
        peer.on('data', bytes => {
            if (origin) appendFileSync(path.join(directory, 'ws-transfer.jsonl'), `${JSON.stringify({ at: Date.now(), origin, bytes: bytes.length })}\n`)
        })
        peer.on('error', () => socket.destroy())
        socket.on('error', () => peer.destroy())
        sockets.add(peer)
        peer.on('close', () => sockets.delete(peer))
    })
    server.on('upgrade', (request, socket, head) => {
        let target
        try { target = resolve(request) } catch { socket.destroy(); return }
        const origin = request.headers.origin
        const record = bytes => appendFileSync(path.join(directory, 'ws-transfer.jsonl'), `${JSON.stringify({ at: Date.now(), origin, bytes })}\n`)
        const upstream = http.request(target)
        upstream.on('upgrade', (response, peer, bytes) => {
            const headers = []
            for (let index = 0; index < response.rawHeaders.length; index += 2) headers.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
            const opening = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`)
            socket.write(opening)
            if (bytes.length) socket.write(bytes)
            record(opening.length + bytes.length)
            if (head.length) peer.write(head)
            peer.on('data', chunk => record(chunk.length))
            peer.on('error', () => socket.destroy())
            socket.on('error', () => peer.destroy())
            peer.pipe(socket)
            socket.pipe(peer)
        })
        upstream.on('error', () => socket.destroy())
        upstream.end()
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(64988, '127.0.0.1', () => resolve(undefined)) })
    return async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
}

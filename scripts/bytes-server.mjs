import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { resolveFile } from './ios-sim/server.mjs'

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }

export async function serveBytes(directory) {
  const cache = new Map()
  const server = createServer(async (request, response) => {
    try {
      const label = (await readFile(path.join(directory, 'served-build'), 'utf8')).trim()
      assert.match(label, /^[a-z0-9-]+$/)
      const root = path.join(directory, label)
      const url = new URL(request.url, 'http://127.0.0.1:62090')
      const file = await resolveFile(root, url.pathname)
      if (!file) { response.writeHead(404); response.end(); return }
      let entry = cache.get(file)
      if (!entry) {
        const raw = await readFile(file)
        entry = { raw, etag: `"${createHash('sha256').update(raw).digest('hex')}"`,
          gzip: gzipSync(raw, { level: 9 }), br: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) }
        cache.set(file, entry)
      }
      const extension = path.extname(file)
      const encoding = /\bbr\b/.test(request.headers['accept-encoding'] ?? '') ? 'br' :
        /\bgzip\b/.test(request.headers['accept-encoding'] ?? '') ? 'gzip' : 'raw'
      const body = entry[encoding]
      const status = request.headers['if-none-match'] === entry.etag ? 304 : 200
      const headers = { 'content-type': types[extension] ?? 'application/octet-stream', etag: entry.etag, vary: 'Accept-Encoding',
        'cache-control': /\/(?:assets|_expo)\//.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate' }
      if (encoding !== 'raw') headers['content-encoding'] = encoding
      if (status === 200) headers['content-length'] = String(body.length)
      response.writeHead(status, headers)
      response.end(status === 304 || request.method === 'HEAD' ? undefined : body)
      await appendFile(path.join(directory, 'static-access.jsonl'), `${JSON.stringify({ at: Date.now(), label, path: url.pathname, status, encoding, raw: entry.raw.length, bytes: status === 304 ? 0 : body.length })}\n`)
    } catch {
      if (!response.headersSent) response.writeHead(503)
      response.end()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(62090, '127.0.0.1', () => resolve(undefined)) })
  return { close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

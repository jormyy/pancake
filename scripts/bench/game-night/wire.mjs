import { request } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { loopback } from './common.mjs'

export function readWireResponse(url, headers = {}) {
  loopback(url)
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { ...headers, 'accept-encoding': 'gzip' } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        try {
          const bytes = Buffer.concat(chunks)
          const encoding = response.headers['content-encoding'] ?? 'identity'
          const body = (encoding === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8')
          resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
            body, bytes: Buffer.byteLength(body), wireBytes: bytes.length, encoding })
        } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('Phone API response timed out')))
    req.end()
  })
}

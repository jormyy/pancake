import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { appendFile } from '../perf-lab/bounded-log.mjs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { delay, sha256, writeGzip } from './common.mjs'

export async function inputSource(directory, transport = fetch) {
  const file = path.join(directory, 'manifest.jsonl')
  const text = await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '' })
  const manifest = new Map(text.split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return [row.key, row] }))
  return async (key, url, kind, timeout = 20000) => {
    const cached = manifest.get(key)
    if (cached?.status === 200) {
      assert.equal(path.basename(cached.file), cached.file)
      const bytes = gunzipSync(await readFile(path.join(directory, cached.file)))
      assert.equal(sha256(bytes), cached.sha256)
      return { bytes, row: cached }
    }
    await delay(400)
    const retrievedAt = new Date().toISOString()
    let bytes = Buffer.alloc(0), status = null, failure = null
    try {
      const response = await transport(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com' }, signal: AbortSignal.timeout(timeout) })
      status = response.status
      bytes = Buffer.from(await response.arrayBuffer())
    } catch (error) { failure = error.message }
    const row = { key, url, kind, provenance: 'REAL-RAW', retrievedAt, status, bytes: bytes.length, sha256: sha256(bytes), file: `${key}-${sha256(bytes)}.gz`, failure }
    await writeGzip(path.join(directory, row.file), bytes)
    await appendFile(file, `${JSON.stringify(row)}\n`)
    manifest.set(key, row)
    return { bytes, row }
  }
}

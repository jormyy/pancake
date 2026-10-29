import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { digest, json, safeHeaders } from './common.mjs'

export function sleeperHeadshotId(value) {
  const url = new URL(value)
  if (url.origin !== 'https://sleepercdn.com' || url.username || url.password || url.search || url.hash) return null
  return /^\/content\/nba\/players\/(\d{1,10})\.jpg$/.exec(url.pathname)?.[1] ?? null
}

export async function readSleeperHeadshot(directory, id) {
  assert.match(id, /^\d{1,10}$/)
  const metadata = JSON.parse(await readFile(path.join(directory, `sleeper-${id}.json`), 'utf8'))
  const body = await readFile(path.join(directory, `sleeper-${id}.bin`))
  assert.equal(digest(body), metadata.sha256, 'Recorded Sleeper image changed')
  return { ...metadata, body }
}

export async function freezeSleeperHeadshots(urls, directory, fetcher = fetch) {
  const rows = []
  const sources = [...new Set(urls)]
  const record = async source => {
    const id = sleeperHeadshotId(source)
    assert.ok(id, 'Only the public Sleeper player-image path can be recorded')
    let existing
    try { existing = await readSleeperHeadshot(directory, id) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (existing) { const { body: _body, ...metadata } = existing; return metadata }
    const response = await fetcher(source, { redirect: 'error', signal: AbortSignal.timeout(20000) })
    assert.ok(response.ok && response.headers.get('content-type')?.startsWith('image/') || [403, 404, 410].includes(response.status), `Sleeper image ${id}: HTTP ${response.status} ${response.headers.get('content-type')}`)
    const body = Buffer.from(await response.arrayBuffer())
    const headers = safeHeaders(Object.fromEntries(response.headers))
    delete headers['content-encoding']
    headers['content-length'] = String(body.length)
    const metadata = { source, id, status: response.status, headers, bytes: body.length, sha256: digest(body) }
    await writeFile(path.join(directory, `sleeper-${id}.bin`), body)
    await json(path.join(directory, `sleeper-${id}.json`), metadata)
    return metadata
  }
  for (let index = 0; index < sources.length; index += 4) {
    const batch = await Promise.allSettled(sources.slice(index, index + 4).map(record))
    const failures = batch.filter(row => row.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(row => row.reason), 'Sleeper image recording failed')
    rows.push(...batch.flatMap(row => row.status === 'fulfilled' ? [row.value] : []))
  }
  return rows
}

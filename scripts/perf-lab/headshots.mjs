import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { digest, json, labRoot, ports, requireMini } from './common.mjs'
import { sql } from './database.mjs'
import { freezeSleeperHeadshots } from './external-headshots.mjs'

export function headshotId(value) {
  const url = new URL(value)
  if (url.origin !== 'https://cdn.nba.com' || url.search || url.hash) return null
  return /^\/headshots\/nba\/latest\/260x190\/(\d{3,10})\.png$/.exec(url.pathname)?.[1] ?? null
}

export async function prepareHeadshots(origin) {
  await requireMini()
  assert.match(origin, new RegExp(`^https://[a-z0-9-]+[.]local:${ports.https}$`))
  const directory = path.join(labRoot, 'fixtures/headshots')
  await mkdir(directory, { recursive: true })
  const ids = JSON.parse(await sql("SELECT coalesce(json_agg(DISTINCT nba_id),'[]') FROM players WHERE nba_id ~ '^[0-9]{3,10}$'"))
  let index = 0, stopped = false
  const result = []
  const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    try {
    while (index < ids.length && !stopped) {
      const id = ids[index++]
      const metadata = path.join(directory, `${id}.json`)
      const previous = JSON.parse(await readFile(metadata, 'utf8').catch(() => 'null'))
      const bytes = await readFile(path.join(directory, `${id}.png`)).catch(() => null)
      if (previous && bytes && digest(bytes) === previous.sha256) { result.push(previous); continue }
      const url = `https://cdn.nba.com/headshots/nba/latest/260x190/${id}.png`
      assert.equal(headshotId(url), id)
      const response = await fetch(url, { headers: { 'user-agent': 'PancakeApp/1.0' }, redirect: 'error', signal: AbortSignal.timeout(20000) })
      const body = Buffer.from(await response.arrayBuffer())
      const row = { id, url, status: response.status, imageResponse: response.headers.get('content-type')?.startsWith('image/') ?? false, contentType: response.headers.get('content-type'), bytes: body.length, sha256: digest(body) }
      await writeFile(path.join(directory, `${id}.png`), body)
      await json(metadata, row)
      result.push(row)
    }
    } catch (error) { stopped = true; throw error }
  }))
  const failed = workers.filter(row => row.status === 'rejected')
  if (failed.length) throw new AggregateError(failed.map(row => row.reason), 'Headshot fixture collection failed')
  const urls = JSON.parse(await sql("SELECT coalesce(json_agg(DISTINCT headshot_url),'[]') FROM players WHERE headshot_url LIKE 'https://sleepercdn.com/content/nba/players/%'"))
  const external = await freezeSleeperHeadshots(urls, directory)
  for (const row of external) {
    row.local = `${origin}/__lab/headshots/sleeper/${row.id}`
    await sql(`UPDATE players SET headshot_url='${row.local}' WHERE headshot_url='${row.source}'`)
  }
  await json(path.join(labRoot, 'evidence/external-headshot-fixtures.json'), external)
  await json(path.join(labRoot, 'evidence/headshot-fixtures.json'), result.sort((a, b) => a.id.localeCompare(b.id)))
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'

await requireMini()
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablerq')
const directory = path.join(labRoot, 'fixtures/headshots')
await mkdir(directory, { recursive: true })
const ids = [
    ...new Set([
        ...JSON.parse(
            await sql(`SELECT json_agg(nba_id) FROM (SELECT nba_id FROM public.players
  ORDER BY display_name LIMIT 120) first_page WHERE nba_id ~ '^[0-9]{3,10}$'`),
        ),
        '1643408',
        '1643409',
    ]),
]
for (const id of ids) {
    const url = `https://cdn.nba.com/headshots/nba/latest/260x190/${id}.png`
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) })
    assert.ok(
        (response.ok && response.headers.get('content-type')?.startsWith('image/')) ||
            [403, 404, 410].includes(response.status),
    )
    const body = Buffer.from(await response.arrayBuffer())
    await writeFile(path.join(directory, `${id}.png`), body)
    await writeFile(
        path.join(directory, `${id}.json`),
        JSON.stringify({
            id,
            url,
            status: response.status,
            contentType: response.headers.get('content-type'),
            sha256: createHash('sha256').update(body).digest('hex'),
        }),
    )
    console.log(`${id}: ${response.status}, ${body.length} bytes`)
}

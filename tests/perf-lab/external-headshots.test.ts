import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { freezeSleeperHeadshots, readSleeperHeadshot, sleeperHeadshotId } from '../../scripts/perf-lab/external-headshots.mjs'

it('accepts only the recorded public Sleeper player-image path', () => {
  expect(sleeperHeadshotId('https://sleepercdn.com/content/nba/players/2416.jpg')).toBe('2416')
  for (const url of ['https://example.com/content/nba/players/2416.jpg', 'https://sleepercdn.com/private', 'https://user:password@sleepercdn.com/content/nba/players/2416.jpg', 'https://sleepercdn.com/content/nba/players/2416.jpg?token=secret']) expect(sleeperHeadshotId(url)).toBe(null)
})

it('freezes the original bytes and cache headers and refuses changed evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'perf-headshot-'))
  const source = 'https://sleepercdn.com/content/nba/players/2416.jpg'
  const calls: string[] = []
  try {
    const rows = await freezeSleeperHeadshots([source, source], directory, async (url) => {
      calls.push(String(url))
      return new Response('image bytes', { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=600', etag: 'version-one' } })
    })
    expect(calls).toEqual([source])
    expect(rows).toMatchObject([{ source, id: '2416', bytes: 11, status: 200 }])
    const asset = await readSleeperHeadshot(directory, '2416')
    expect(asset.body.toString()).toBe('image bytes')
    expect(asset.headers['cache-control']).toBe('public, max-age=600')
    expect(asset.headers.etag).toBe('version-one')
    await freezeSleeperHeadshots([source], directory, async () => { throw new Error('A frozen image must not refetch') })
    expect(await readFile(path.join(directory, 'sleeper-2416.bin'), 'utf8')).toBe('image bytes')
    await expect(readSleeperHeadshot(directory, '../escape')).rejects.toThrow()
    await writeFile(path.join(directory, 'sleeper-2416.bin'), 'changed')
    await expect(readSleeperHeadshot(directory, '2416')).rejects.toThrow('Recorded Sleeper image changed')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.each([403, 404, 410])('preserves an original HTTP %s response instead of inventing a successful asset', async status => {
  const directory = await mkdtemp(path.join(tmpdir(), 'perf-headshot-missing-'))
  try {
    const rows = await freezeSleeperHeadshots(['https://sleepercdn.com/content/nba/players/999999.jpg'], directory,
      async () => new Response('not found', { status, headers: { 'content-type': 'text/plain' } }))
    expect(rows[0]).toMatchObject({ status, bytes: 9 })
    expect((await readSleeperHeadshot(directory, '999999')).body.toString()).toBe('not found')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

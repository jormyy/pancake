import assert from 'node:assert/strict'

Deno.env.set('NBA_CDN_BASE_URL', 'http://nba.invalid')
const { fetchBoxScore } = await import('./nba.ts')

Deno.test('live NBA ordering uses the actual ET snapshot time while official revisions keep their existing representation', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ meta: { time: '2026-10-29 21:00:46.511097' }, game: { gameEt: '2026-10-29T20:00:00-04:00' } },
    { headers: { 'last-modified': 'Fri, 30 Oct 2026 01:09:47 GMT' } })
  try {
    const box = await fetchBoxScore('0022600144', 2500)
    assert.equal(box.sourceUpdatedAt, '2026-10-29T21:00:46.511097Z')
    assert.equal(Date.parse(box.liveSourceUpdatedAt!), Date.parse('2026-10-30T01:00:46.511Z'))
  } finally { globalThis.fetch = original }
})

Deno.test('missing source timezone metadata uses the object timestamp for live ordering', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ meta: { time: '2026-10-29 09:00:42.042' }, game: {} },
    { headers: { 'last-modified': 'Fri, 30 Oct 2026 01:00:43 GMT' } })
  try {
    assert.equal((await fetchBoxScore('0022600144', 2500)).liveSourceUpdatedAt, '2026-10-30T01:00:43.000Z')
  } finally { globalThis.fetch = original }
})

import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2'
import type { Database } from '../_shared/database.ts'
import { syncSleeperProjections } from './sync.ts'

const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/week-2026-1.json', import.meta.url)))
const context = { seasonYear: 2027, weekNumber: 1, sleeperWeek: 1, weekStart: '2026-10-19', weekEnd: '2026-10-25' }

Deno.test('records HTTP, shape, and storage failures while preserving the last successful write', async () => {
  const writes: unknown[] = [], failures: Record<string, unknown>[] = []
  let rejectStorage = false
  const client = createClient<Database>('http://127.0.0.1:1', 'fixture-only', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.pathname.endsWith('/players')) return Response.json(fixture.map((row: { player_id: string }, i: number) => ({
      id: `00000000-0000-0000-0000-00000000000${i}`, sleeper_id: row.player_id, display_name: null, nba_team: null,
    })))
    if (url.pathname.endsWith('/complete_sleeper_projection_sync')) {
      if (rejectStorage) return Response.json({ message: 'Atomic write rejected' }, { status: 500 })
      writes.push(body)
      return Response.json(3)
    }
    if (url.pathname.endsWith('/projection_sync_runs')) {
      if (init?.method === 'PATCH') { failures.push(body); return new Response(null, { status: 204 }) }
      return Response.json({ id: '00000000-0000-0000-0000-000000000010' })
    }
    throw new Error(`Unexpected database request: ${url}`)
  } } })
  const good = () => syncSleeperProjections(client, context, () => Promise.resolve(Response.json(fixture)))
  await good()
  assert.equal(writes.length, 1)
  for (const response of [new Response('down', { status: 503 }), Response.json({ error: 'changed shape' }), Response.json([{ ...fixture[0], stats: {} }])]) {
    await assert.rejects(() => syncSleeperProjections(client, context, () => Promise.resolve(response)))
  }
  rejectStorage = true
  await assert.rejects(good, /Atomic write rejected/)
  assert.equal(writes.length, 1)
  assert.equal(failures.length, 4)
  assert.ok(failures.every((run) => run.status === 'failed' && run.completed_at && run.error_message))
  rejectStorage = false
  await good()
  assert.equal(writes.length, 2)
})

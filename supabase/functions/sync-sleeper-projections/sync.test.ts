import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2'
import type { Database } from '../_shared/database.ts'
import { syncSleeperProjections } from './sync.ts'

const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/matched-sample.json', import.meta.url)))
const context = { seasonYear: 2027, weekNumber: 1, sleeperWeek: 1, weekStart: '2026-10-19', weekEnd: '2026-10-25' }

Deno.test('records HTTP, shape, and storage failures while preserving the last successful write', async () => {
  const writes: Array<{ p_row_count: number; p_metadata: Record<string, unknown>; p_rows: Array<{ points: number; minutes: number }> }> = [], failures: Record<string, unknown>[] = []
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
      return Response.json(body.p_rows.length)
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
  const partial = [...fixture, { ...fixture[0], game_id: `${fixture[0].game_id}1`, stats: {} },
    { ...fixture[1], game_id: `${fixture[1].game_id}1` }, { ...fixture[0], date: 'outside-the-week' }]
  await syncSleeperProjections(client, context, () => Promise.resolve(Response.json(partial)))
  assert.equal(writes[1].p_row_count, 5)
  assert.deepEqual(writes[1].p_metadata, { inputRowCount: 6, rejectedRowCount: 1, seenSourceKeys: partial.slice(0, 5).map((row) => ({ sleeper_id: row.player_id, source_game_id: row.game_id })), unmatchedIds: [], weekStart: context.weekStart, weekEnd: context.weekEnd })
  assert.equal(writes[1].p_rows[3].points, 0)
  assert.equal(writes[1].p_rows[3].minutes, 0)
  for (const response of [new Response('down', { status: 503 }), Response.json({ error: 'changed shape' }), Response.json([{ ...fixture[0], stats: { gp: 1, pts: 'bad' } }]), Response.json([...fixture, fixture[0]])]) {
    await assert.rejects(() => syncSleeperProjections(client, context, () => Promise.resolve(response)))
  }
  rejectStorage = true
  await assert.rejects(good, /Atomic write rejected/)
  assert.equal(writes.length, 2)
  assert.equal(failures.length, 5)
  assert.deepEqual(failures[3].source_metadata, { inputRowCount: 4, rejectedRowCount: 1, weekStart: context.weekStart, weekEnd: context.weekEnd })
  assert.ok(failures.every((run) => run.status === 'failed' && run.completed_at && run.error_message))
  rejectStorage = false
  await good()
  assert.equal(writes.length, 3)
})

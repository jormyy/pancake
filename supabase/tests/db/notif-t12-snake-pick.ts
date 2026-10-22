import { strict as assert } from 'node:assert'
import { SignedFixture, fresh, known, post } from './notif-t12-support.ts'
import { Clock, Transport, expectRows, q, rows, sql, type League, type OutboxRow } from './notif-t9-support.ts'

// F6 on-clock rows behind the API routes a manager and a commissioner use:
// /draft/:id/snake-pick -> make_snake_pick_atomic for the manager's own pick,
// and /draft/:id/commissioner-pick -> commissioner_snake_pick_atomic after the
// close-expired-nominations worker has paused the draft on a real timer expiry.
// After each pick the next drafter gets exactly one draft_on_clock keyed by the
// next pick, in that league only, and opted-out users are suppressed at send time.
const clock = new Clock(), fixture = new SignedFixture(), transport = new Transport()
const file = 'supabase/tests/db/notif-t12-snake-pick.ts'
type Room = { league: League; draft: string }
type Pick = { id: string; member_id: string; overall_pick: number }
type Response = { status: number; body: Record<string, unknown> }
const rooms: Room[] = []
async function upcoming(room: Room) {
  return JSON.parse(await sql(`SELECT json_agg(row_to_json(p) ORDER BY overall_pick) FROM (SELECT id,member_id,overall_pick FROM snake_draft_picks WHERE draft_id=${q(room.draft)} AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 2) p`)) as Pick[]
}
async function picked(label: string, path: string, pick: (room: Room, current: Pick) => Promise<Response>) {
  const before = await known('draft_on_clock'), pushes = transport.pushes.length
  const steps: { room: Room; current: Pick; next: Pick }[] = []
  for (const room of rooms) {
    const [current, next] = await upcoming(room)
    assert.ok(current && next, 'Two picks remain')
    const response = await pick(room, current)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(await sql(`SELECT picked_at IS NOT NULL FROM snake_draft_picks WHERE id=${q(current.id)}`), 't')
    steps.push({ room, current, next })
  }
  assert.equal(transport.pushes.length, pushes, 'The pick route never sends inline')
  const created = await rows('draft_on_clock', fresh(before))
  assert.deepEqual(created.map(row => row.member_id).sort(), steps.map(step => step.next.member_id).sort(), 'Across every league only the next drafter of each draft is on the clock')
  const batch: OutboxRow[] = []
  for (const { room, current, next } of steps) {
    const retry = async () => {
      const again = await pick(room, current)
      assert.ok(again.status >= 400 && again.status < 500, `A repeated pick is refused: ${JSON.stringify(again)}`)
    }
    const [row] = await expectRows('draft_on_clock', `${fresh(before)} AND data->>'draftId'=${q(room.draft)}`, [next.member_id], retry)
    assert.equal(row.dedupe_key, `draft_on_clock:${next.id}:${next.member_id}`)
    assert.deepEqual([row.category, row.data.draftId, row.data.pickId, row.data.body], ['draft', room.draft, next.id, `You are on the clock for pick ${next.overall_pick}.`])
    assert.equal(await sql(`SELECT league_id FROM league_members WHERE id=${q(row.member_id)}`), room.league.id)
    batch.push(row)
  }
  await fixture.negative(['draft_on_clock'])
  await transport.prove(fixture, batch, `${file}#${label}`, path)
  return steps
}
try {
  await fixture.signIn()
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  const api = await transport.serve(() => import('../../functions/api/index.ts'))
  const closer = await transport.serve(() => import('../../functions/close-expired-nominations/index.ts'))
  const players: string[] = []
  for (let index = 0; index < 8; index++) players.push(await fixture.player())
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league('offseason', rotation)
    await sql(`INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id) SELECT ${q(league.id)},${league.year},r,m,m FROM generate_series(1,2) r CROSS JOIN unnest(ARRAY[${league.members.map(q)}]::uuid[]) m`)
    const draft = JSON.parse(await sql(`SELECT start_rookie_draft_atomic(${q(league.id)},2,false,60,'commissioner_pick')`)).id
    rooms.push({ league, draft })
  }

  // A manager picks for their own team while on the clock.
  await picked('snake-pick', 'edge-http:api /draft/:id/snake-pick + trigger', (room, current) =>
    post(api, `/draft/${room.draft}/snake-pick`, fixture.token(current.member_id), { memberId: current.member_id, playerId: players[0] }))

  // The next pick's 60 s timer runs out; the worker pauses each draft for the commissioner.
  await clock.at('2026-10-21T16:01:30Z')
  const expired = await transport.invoke(closer)
  assert.equal(expired.status, 200, JSON.stringify(expired.body))
  for (const room of rooms) assert.equal(await sql(`SELECT status || ':' || pause_reason FROM drafts WHERE id=${q(room.draft)}`), 'paused:timer_expired_commissioner_pick')

  // The commissioner makes the expired pick, which resumes the draft.
  await picked('commissioner-pick', 'edge-http:api /draft/:id/commissioner-pick + trigger', (room, current) =>
    post(api, `/draft/${room.draft}/commissioner-pick`, fixture.token(room.league.members[0]), { memberId: current.member_id, playerId: players[1] }))
  for (const room of rooms) assert.equal(await sql(`SELECT status FROM drafts WHERE id=${q(room.draft)}`), 'in_progress')
  console.log('SYNTHETIC: rookie drafts picked through the real API routes by signed-in users, a manager pick (/snake-pick) and a commissioner pick (/commissioner-pick) after a worker-processed timer expiry; one draft_on_clock per next drafter keyed by the next pick, no row for any other membership or league, refused repeats add nothing, foreign/non-member negatives, send-time switches and receipts')
} finally {
  try {
    await transport.close()
    await fixture.cleanup()
  } finally {
    await clock.restore()
  }
}

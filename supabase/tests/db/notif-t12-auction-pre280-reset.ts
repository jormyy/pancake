import { strict as assert } from 'node:assert'
import { SignedFixture, post } from './notif-t12-support.ts'
import { Clock, Transport, expectRows, q, rows, sql, type League, type OutboxRow } from './notif-t9-support.ts'

// An auction already running when migration 280 shipped has no turn rows: 280
// replaces notif_draft_clock and notif_is_stale and adds deferred triggers, and
// backfills nothing. Each room is driven to an in-progress auction with a sold
// and an open nomination at order 2, and its turn rows are then removed, which
// is the state such a draft is in after deploy. It is then reset through the
// real API route (/draft/:id/reset -> reset_draft_atomic). The restarted
// nominator must get exactly one turn notice, with no duplicate from pause and
// resume, worker runs or repeated drains. A repeated reset request starts a new
// generation: the superseded turn row goes stale at send time and is never pushed.
const clock = new Clock(), fixture = new SignedFixture(), transport = new Transport()
const file = 'supabase/tests/db/notif-t12-auction-pre280-reset.ts'
type Room = { league: League; draft: string }
const rooms: Room[] = []
const user = (member: string) => fixture.memberUsers.get(member)!
const seat = (room: Room, order: number) => room.league.members[(order - 1) % room.league.members.length]
const draftScope = (room: Room) => `data->>'draftId'=${q(room.draft)}`
const turnEvents = `event_type IN ('draft_on_clock','draft_coming_soon')`
const drafts = () => `data->>'draftId' IN (${rooms.map(room => q(room.draft))})`
const resets = (room: Room) => sql(`SELECT count(*) FROM draft_audit_logs WHERE draft_id=${q(room.draft)} AND action='reset'`)
async function nominate(room: Room, order: number) {
  const member = seat(room, order), player = await fixture.player()
  return await sql(`SELECT (create_auction_nomination_atomic(${q(room.draft)},${q(member)},${q(player)},${q(user(member))},5)).id`)
}
async function terminal(ids: string[]) {
  let states: OutboxRow[] = []
  for (let pass = 0; pass < 40; pass++) {
    states = JSON.parse(await sql(`SELECT json_agg(row_to_json(o)) FROM notification_outbox o WHERE id IN (${ids.map(q)})`))
    if (states.every(row => row.suppressed_at || row.delivered_at)) break
    await transport.drain()
  }
  return states
}
try {
  await fixture.signIn()
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  const api = await transport.serve(() => import('../../functions/api/index.ts'))
  const closer = await transport.serve(() => import('../../functions/close-expired-nominations/index.ts'))
  const close = async () => {
    const response = await transport.invoke(closer)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body
  }
  const commissioner = async (room: Room, action: string) => {
    const response = await post(api, `/draft/${room.draft}/${action}`, fixture.token(room.league.members[0]))
    assert.equal(response.status, 200, `${action}: ${JSON.stringify(response.body)}`)
  }
  const pauseResume = async () => {
    for (const room of rooms) { await commissioner(room, 'pause'); await commissioner(room, 'resume') }
    await close()
  }

  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league('setup', rotation)
    const draft = JSON.parse(await sql(`SELECT row_to_json(d) FROM start_auction_draft_atomic(${q(league.id)},'user_nominated',false,5,200) d`)).id
    rooms.push({ league, draft })
  }
  for (const room of rooms) {
    const nomination = await nominate(room, 1)
    await sql(`SELECT place_auction_bid_atomic(${q(room.draft)},${q(room.league.members[2])},${q(nomination)},1,${q(user(room.league.members[2]))},false)`)
  }
  await clock.at('2026-10-21T16:01:00Z')
  await close()
  for (const room of rooms) await nominate(room, 2)

  // The pre-280 state: nothing above may leave a turn row behind.
  const removed = Number(await sql(`WITH gone AS (DELETE FROM notification_outbox WHERE ${turnEvents} AND ${drafts()} RETURNING 1) SELECT count(*) FROM gone`))
  assert.ok(removed >= 2 * rooms.length, 'This build wrote turn rows before they were removed')
  for (const room of rooms) {
    assert.equal(await sql(`SELECT status || ':' || current_nomination_order FROM drafts WHERE id=${q(room.draft)}`), 'in_progress:2')
    assert.equal(await sql(`SELECT string_agg(status::text, ',' ORDER BY status::text) FROM nominations WHERE draft_id=${q(room.draft)}`), 'open,sold')
    assert.equal(await resets(room), '0')
  }
  await close()
  assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE ${turnEvents} AND ${drafts()}`), '0', 'A worker run alone does not write turn rows for an untouched pre-280 auction')
  assert.equal(transport.pushes.length, 0)

  for (const room of rooms) await commissioner(room, 'reset')
  const notices: OutboxRow[] = []
  for (const room of rooms) {
    assert.equal(await sql(`SELECT status || ':' || current_nomination_order FROM drafts WHERE id=${q(room.draft)}`), 'in_progress:1')
    assert.equal(await sql(`SELECT count(*) FROM nominations WHERE draft_id=${q(room.draft)}`), '0', 'The reset cleared both nominations')
    assert.equal(await sql(`SELECT string_agg(actor_user_id::text, ',') FROM draft_audit_logs WHERE draft_id=${q(room.draft)} AND action='reset'`), user(room.league.members[0]), 'One reset, by the signed-in commissioner')
    const [turn] = await expectRows('draft_on_clock', draftScope(room), [seat(room, 1)], pauseResume)
    assert.equal(turn.dedupe_key, `draft_on_clock:${room.draft}:nomination:1:1:${seat(room, 1)}`)
    assert.deepEqual([turn.data.resets, turn.data.nominationOrder, turn.data.body], [1, 1, 'You are on the clock to nominate a player.'])
    const [soon] = await expectRows('draft_coming_soon', draftScope(room), [seat(room, 2)], pauseResume)
    assert.equal(soon.dedupe_key, `draft_coming_soon:${room.draft}:nomination:1:2:${seat(room, 2)}`)
    notices.push(turn, soon)
  }
  await fixture.negative(['draft_on_clock', 'draft_coming_soon'])
  await transport.prove(fixture, notices, `${file}#reset-after-280`, 'edge-http:api /draft/:id/reset + deferred trigger')
  for (const room of rooms) {
    assert.equal(transport.pushes.filter(push => push.data.notificationEvent === 'draft_on_clock' && notices.some(row => row.id === push.data.outboxId && row.data.draftId === room.draft)).length,
      fixture.memberUsers.get(seat(room, 1)) === fixture.users[3] ? 1 : 0, 'At most one turn push per room, only where the switches allow it')
  }

  // A second reset request before anything is sent: generation 2 is superseded
  // by generation 3 and must go stale; generation 3 follows the switches above.
  const before = (await rows('draft_on_clock', drafts())).map(row => row.id)
  for (const room of rooms) { await commissioner(room, 'reset'); await commissioner(room, 'reset') }
  const repeated = await rows('draft_on_clock', `${drafts()} AND id NOT IN (${before.map(q)})`)
  assert.equal(repeated.length, 2 * rooms.length, 'Each reset generation keys its own turn row')
  const states = await terminal(repeated.map(row => row.id))
  for (const room of rooms) {
    assert.equal(await resets(room), '3')
    const own = states.filter(row => row.data.draftId === room.draft)
    assert.deepEqual(own.map(row => row.member_id), [seat(room, 1), seat(room, 1)])
    const [stale, live] = [own.find(row => row.data.resets === 2)!, own.find(row => row.data.resets === 3)!]
    assert.equal(transport.pushes.filter(push => push.data.outboxId === stale.id).length, 0, 'The superseded generation is never pushed')
    // Only staleness can stop the control user's row; an opted-out user's row
    // may be caught by either check, depending on which claim batch reaches it.
    if (fixture.memberUsers.get(seat(room, 1)) === fixture.users[3]) {
      assert.equal(stale.suppression_reason, 'stale', 'The superseded generation is stale at send time')
      assert.ok(live.delivered_at, 'The live generation is delivered to the control user')
    } else {
      assert.ok(['stale', 'preferences_disabled'].includes(stale.suppression_reason!), JSON.stringify(stale))
      assert.equal(live.suppression_reason, 'preferences_disabled')
    }
  }
  console.log('SYNTHETIC: pre-280 in-progress auctions (sold and open nominations, order 2, no turn rows) reset through the real API route by the signed-in commissioner; exactly one draft_on_clock for the restarted nominator and one draft_coming_soon for the next, keyed to the reset generation; pause/resume, worker and drain retries add nothing; foreign/non-member negatives; send-time switches and receipts; a repeated reset leaves the superseded generation stale and unsent')
} finally {
  try {
    await transport.close()
    // A sold nomination's roster transaction blocks the fixture's draft delete.
    if (rooms.length) await sql(`DELETE FROM roster_transactions WHERE league_id IN (${rooms.map(room => q(room.league.id))})`)
    await fixture.cleanup()
  } finally {
    await clock.restore()
  }
}

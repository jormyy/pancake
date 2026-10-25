import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, rows, sql, type League, type OutboxRow } from './notif-t9-support.ts'

// Auction draft turns: the nominator is on the clock ("Your turn") and the next
// nominator is coming up, driven by the real start, nomination and bid RPCs and
// the close-expired-nominations worker. Auctions have no per-member pick timer
// and no auto-pick (timer expiry is always auction_no_bid), so
// draft_timer_expiring and draft_auto_picked must stay silent.
const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
const file = 'supabase/tests/db/notif-t10-auction.ts'
type Room = { league: League; draft: string }
const rooms: Room[] = []
const user = (member: string) => fixture.memberUsers.get(member)!
let since = ''
const turn = (room: Room, order: number) => `data->>'draftId'=${q(room.draft)} AND data->>'nominationOrder'=${q(String(order))}${since}`
const drafts = () => `data->>'draftId' IN (${rooms.map(room => q(room.draft))})`
const seat = (room: Room, order: number) => room.league.members[(order - 1) % room.league.members.length]
async function nominate(room: Room, order: number) {
  const member = seat(room, order), player = await fixture.player()
  return await sql(`SELECT (create_auction_nomination_atomic(${q(room.draft)},${q(member)},${q(player)},${q(user(member))},5)).id`)
}
async function turns(order: number, retry: () => Promise<unknown>) {
  const batch: OutboxRow[] = []
  for (const room of rooms) {
    const body = (await rows('draft_on_clock', turn(room, order))).map(row => row.data.body)
    batch.push(...await expectRows('draft_on_clock', turn(room, order), [seat(room, order)], retry))
    assert.deepEqual(body, ['You are on the clock to nominate a player.'])
    batch.push(...await expectRows('draft_coming_soon', turn(room, order + 1), [seat(room, order + 1)], retry))
  }
  return batch
}
async function terminal(batch: OutboxRow[]) {
  let states: OutboxRow[] = []
  for (let pass = 0; pass < 40; pass++) {
    states = JSON.parse(await sql(`SELECT json_agg(row_to_json(o)) FROM notification_outbox o WHERE id IN (${batch.map(row => q(row.id))})`))
    if (states.every(row => row.suppressed_at || row.delivered_at)) break
    await transport.drain()
  }
  return states
}
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  const closer = await transport.serve(() => import('../../functions/close-expired-nominations/index.ts'))
  const close = async () => {
    const response = await transport.invoke(closer)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body
  }
  const pauseResume = async () => {
    for (const room of rooms) await sql(`SELECT pause_draft_atomic(${q(room.draft)},${q(user(room.league.members[0]))}); SELECT resume_draft_atomic(${q(room.draft)},${q(user(room.league.members[0]))});`)
    await close()
  }
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league('setup', rotation)
    const draft = JSON.parse(await sql(`SELECT row_to_json(d) FROM start_auction_draft_atomic(${q(league.id)},'user_nominated',false,5,200) d`)).id
    assert.deepEqual(JSON.parse(await sql(`SELECT json_agg(member_id ORDER BY position) FROM draft_orders WHERE draft_id=${q(draft)}`)), league.members, 'Nomination seats follow the fixture member order')
    rooms.push({ league, draft })
  }
  await transport.prove(fixture, await turns(1, pauseResume), `${file}#start`, 'sql-rpc:start_auction_draft_atomic + deferred trigger')

  const sold: string[] = []
  for (const room of rooms) {
    const nomination = await nominate(room, 1)
    await sql(`SELECT place_auction_bid_atomic(${q(room.draft)},${q(room.league.members[2])},${q(nomination)},1,${q(user(room.league.members[2]))},false)`)
    assert.equal((await rows('draft_on_clock', turn(room, 2))).length, 0, 'The turn passes only when the nomination closes')
    sold.push(nomination)
  }
  await clock.at('2026-10-21T16:01:00Z')
  assert.ok(Number((await close()).closed) >= rooms.length)
  assert.equal(await sql(`SELECT count(*) FROM nominations WHERE id IN (${sold.map(q)}) AND status='sold'`), String(rooms.length))
  await transport.prove(fixture, await turns(2, close), `${file}#sold`, 'edge-http:close-expired-nominations + deferred trigger')

  const unsold: string[] = []
  for (const room of rooms) unsold.push(await nominate(room, 2))
  await clock.at('2026-10-21T16:02:00Z')
  await close()
  assert.equal(await sql(`SELECT count(*) FROM nominations WHERE id IN (${unsold.map(q)}) AND status='no_bid'`), String(rooms.length))
  const third = await turns(3, close)
  for (const room of rooms) await nominate(room, 3)
  const states = await terminal(third)
  for (const row of states) {
    const pushes = transport.pushes.filter(push => push.data.outboxId === row.id).length
    if (row.event_type === 'draft_on_clock') {
      assert.equal(row.suppression_reason, 'stale', 'A nominator who already nominated is no longer on the clock')
      assert.equal(pushes, 0)
    } else assert.notEqual(row.suppression_reason, 'stale', 'The next nominator is still next')
  }
  await clock.scan('2026-10-21T16:02:30Z')
  for (const event of ['draft_timer_expiring', 'draft_auto_picked']) assert.equal((await rows(event, drafts())).length, 0, `Auctions have no ${event}`)

  await sql(`UPDATE draft_budgets SET remaining=0 WHERE draft_id IN (${rooms.map(room => q(room.draft))})`)
  await clock.at('2026-10-21T16:03:00Z')
  await close()
  for (const room of rooms) {
    assert.equal(await sql(`SELECT status FROM drafts WHERE id=${q(room.draft)}`), 'completed', 'Nobody can still buy, so the closing nomination completes the draft')
    assert.equal((await rows('draft_on_clock', turn(room, 4))).length + (await rows('draft_coming_soon', turn(room, 5))).length, 0, 'A completed draft has no next turn')
    await expectRows('draft_finished', `data->>'draftId'=${q(room.draft)}`, room.league.members, close)
  }

  // A reset keeps the draft id and restarts the nomination order at 1, so the
  // restarted turns must not dedupe into the turns already sent before it.
  const sent = JSON.parse(await sql(`SELECT COALESCE(json_agg(id),'[]') FROM notification_outbox WHERE ${drafts()}`)) as string[]
  since = ` AND id NOT IN (${sent.map(q)})`
  for (const room of rooms) await sql(`SELECT reset_draft_atomic(${q(room.draft)},${q(user(room.league.members[0]))})`)
  for (const room of rooms) assert.equal(await sql(`SELECT status || ':' || current_nomination_order FROM drafts WHERE id=${q(room.draft)}`), 'in_progress:1')
  await transport.prove(fixture, await turns(1, pauseResume), `${file}#reset`, 'sql-rpc:reset_draft_atomic + deferred trigger')
  console.log('SYNTHETIC: real auction start, nomination, bid and close-expired-nominations worker; exact nominator and next-nominator recipients per turn, foreign/non-member negatives, pause/resume and worker retries, send-time switches and receipts, stale turn after nominating, no timer/auto-pick events, no turn after completion, fresh turns after a reset')
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

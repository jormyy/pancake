import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, rows, sql, type League, type OutboxRow } from './notif-t9-support.ts'

const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
type Room = { league: League; draft: string }
const rooms: Room[] = []
const spurious: string[] = []
const roomScope = () => `data->>'draftId' IN (${rooms.map(room => q(room.draft))})`
const known = async (event: string) => (await rows(event, roomScope())).map(row => row.id)
const freshScope = (ids: string[]) => roomScope() + (ids.length ? ` AND id NOT IN (${ids.map(q)})` : '')
async function current(room: Room) {
  return JSON.parse(await sql(`SELECT row_to_json(p) FROM (SELECT * FROM snake_draft_picks WHERE draft_id=${q(room.draft)} AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1) p`)) as { id: string; member_id: string }
}
async function rejected(source: string) { await assert.rejects(() => sql(source), /Only an|Only a|already exists|not waiting|not in progress|not your turn|turn|pick|completed|paused|League must be in playoffs|League must be in offseason/i) }
async function broadcast(event: string, before: string[], retry: () => Promise<unknown>) {
  const batch = await expectRows(event, freshScope(before), rooms.flatMap(room => room.league.members), retry)
  await transport.prove(fixture, batch, 'supabase/tests/db/notif-t9-draft.ts:17')
}
async function turns(beforeClock: string[], beforeSoon: string[], retry: () => Promise<unknown>, extra: OutboxRow[] = []) {
  const onClock: string[] = [], comingSoon: string[] = []
  for (const room of rooms) {
    const picks = JSON.parse(await sql(`SELECT json_agg(row_to_json(p) ORDER BY overall_pick) FROM (SELECT member_id,overall_pick FROM snake_draft_picks WHERE draft_id=${q(room.draft)} AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 2) p`)) as { member_id: string }[] | null
    if (picks?.[0]) onClock.push(picks[0].member_id)
    if (picks?.[1]) comingSoon.push(picks[1].member_id)
  }
  const batch = [...extra]
  if (onClock.length) batch.push(...await expectRows('draft_on_clock', freshScope(beforeClock), onClock, retry))
  if (comingSoon.length) batch.push(...await expectRows('draft_coming_soon', freshScope(beforeSoon), comingSoon, retry))
  if (batch.length) await transport.prove(fixture, batch, 'supabase/tests/db/notif-t9-draft.ts:29')
}
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  for (let i = 0; i < 24; i++) await fixture.player()
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league('offseason', rotation)
    await sql(`INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id) SELECT ${q(league.id)},${league.year},r,m,m FROM generate_series(1,2) r CROSS JOIN unnest(ARRAY[${league.members.map(q)}]::uuid[]) m`)
    const draft = JSON.parse(await sql(`SELECT start_rookie_draft_atomic(${q(league.id)},2,false,60,'commissioner_pick')`)).id
    rooms.push({ league, draft })
  }
  const retryStart = async () => { for (const room of rooms) await rejected(`SELECT start_rookie_draft_atomic(${q(room.league.id)},2,false,60)` ) }
  const started = await expectRows('draft_started', roomScope(), rooms.flatMap(room => room.league.members), retryStart)
  await turns([], [], retryStart, started)
  for (let cycle = 0; cycle < 2; cycle++) {
    const pausedBefore = await known('draft_paused')
    for (const room of rooms) await sql(`SELECT pause_draft_atomic(${q(room.draft)},${q(fixture.memberUsers.get(room.league.members[0])!)})`)
    await broadcast('draft_paused', pausedBefore, async () => { for (const room of rooms) await rejected(`SELECT pause_draft_atomic(${q(room.draft)})`) })
    const resumedBefore = await known('draft_resumed')
    for (const room of rooms) await sql(`SELECT resume_draft_atomic(${q(room.draft)},${q(fixture.memberUsers.get(room.league.members[0])!)})`)
    await broadcast('draft_resumed', resumedBefore, async () => { for (const room of rooms) await rejected(`SELECT resume_draft_atomic(${q(room.draft)})`) })
  }
  const auctionRooms: Room[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league('setup', rotation)
    const draft = JSON.parse(await sql(`SELECT row_to_json(d) FROM start_auction_draft_atomic(${q(league.id)},'user_nominated',false,60,200) d`)).id
    auctionRooms.push({ league, draft })
  }
  const auctionScope = `data->>'draftId' IN (${auctionRooms.map(room => q(room.draft))})`
  for (let cycle = 0; cycle < 2; cycle++) {
    const pausedBefore = (await rows('draft_paused', auctionScope)).map(row => row.id)
    const pause = async () => { for (const room of auctionRooms) await sql(`SELECT pause_draft_for_absence_atomic(${q(room.draft)},${q(fixture.memberUsers.get(room.league.members[0])!)})`) }
    await pause()
    const paused = await expectRows('draft_paused', auctionScope + (pausedBefore.length ? ` AND id NOT IN (${pausedBefore.map(q)})` : ''), auctionRooms.flatMap(room => room.league.members), pause)
    await transport.prove(fixture, paused, 'supabase/tests/db/notif-t9-draft.ts:65')
    const resumedBefore = (await rows('draft_resumed', auctionScope)).map(row => row.id)
    const rejoin = async () => { for (const room of auctionRooms) await sql(`SELECT resume_draft_if_absent_atomic(${q(room.draft)},${q(fixture.memberUsers.get(room.league.members[0])!)})`) }
    await rejoin()
    const resumed = await expectRows('draft_resumed', auctionScope + (resumedBefore.length ? ` AND id NOT IN (${resumedBefore.map(q)})` : ''), auctionRooms.flatMap(room => room.league.members), rejoin)
    const audits = JSON.parse(await sql(`SELECT json_agg(row_to_json(a)) FROM (SELECT id,draft_id,metadata FROM draft_audit_logs WHERE draft_id IN (${auctionRooms.map(room => q(room.draft))}) AND action='resume') a`)) as { id: string; draft_id: string; metadata: Record<string, unknown> }[]
    assert.equal(audits.length, (cycle + 1) * auctionRooms.length, 'Rejoin retry must not create another resume occurrence')
    for (const audit of audits) {
      assert.equal(audit.metadata.reason, 'member_absent_rejoined')
      assert.equal(audit.metadata.previousStatus, undefined)
      const room = auctionRooms.find(room => room.draft === audit.draft_id)!
      assert.deepEqual((await rows('draft_resumed', `dedupe_key LIKE ${q('draft_resumed:' + audit.id + ':%')}`)).map(row => row.member_id).sort(), [...room.league.members].sort(), 'Each rejoin audit notifies only its league members')
    }
    await transport.prove(fixture, resumed, 'supabase/tests/db/notif-t9-draft.ts:69')
  }
  for (const room of rooms) await sql(`UPDATE snake_draft_picks SET timer_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=${q((await current(room)).id)}`)
  await sql(clock.minute)
  const expiry = await expectRows('draft_timer_expiring', roomScope(), await Promise.all(rooms.map(async room => (await current(room)).member_id)), () => sql(clock.minute))
  await transport.prove(fixture, expiry, 'supabase/tests/db/notif-t9-draft.ts:83')
  let clockBefore = await known('draft_on_clock'), soonBefore = await known('draft_coming_soon')
  const firstOwners: string[] = []
  for (const room of rooms) {
    const pick = await current(room)
    firstOwners.push(pick.member_id)
    await sql(`SELECT make_snake_pick_atomic(${q(room.draft)},${q(pick.member_id)},${q(fixture.players[0])})`)
  }
  await turns(clockBefore, soonBefore, async () => { for (const [index, room] of rooms.entries()) await rejected(`SELECT make_snake_pick_atomic(${q(room.draft)},${q(firstOwners[index])},${q(fixture.players[0])})`) })
  const pausedBefore = await known('draft_paused')
  for (const room of rooms) {
    await sql(`UPDATE snake_draft_picks SET timer_expires_at=clock_timestamp()-interval '1 second' WHERE id=${q((await current(room)).id)}; SELECT * FROM process_expired_snake_pick_atomic(${q(room.draft)});`)
  }
  await broadcast('draft_paused', pausedBefore, async () => { for (const room of rooms) await sql(`SELECT * FROM process_expired_snake_pick_atomic(${q(room.draft)})`) })
  const resumedBefore = await known('draft_resumed')
  clockBefore = await known('draft_on_clock'); soonBefore = await known('draft_coming_soon')
  for (const room of rooms) await sql(`SELECT commissioner_snake_pick_atomic(${q(room.draft)},${q((await current(room)).member_id)},${q(fixture.players[1])},${q(fixture.memberUsers.get(room.league.members[0])!)})`)
  if ((await known('draft_resumed')).length !== resumedBefore.length) spurious.push('Commissioner pick broadcasts a human draft_resumed event')
  await turns(clockBefore, soonBefore, async () => { for (const room of rooms) await rejected(`SELECT commissioner_snake_pick_atomic(${q(room.draft)},${q(room.league.members[0])},${q(fixture.players[1])})`) })
  for (let overall = 3; overall <= 8; overall++) {
    const autoBefore = await known('draft_auto_picked')
    clockBefore = await known('draft_on_clock'); soonBefore = await known('draft_coming_soon')
    const owners = []
    for (const room of rooms) {
      const pick = await current(room)
      owners.push(pick.member_id)
      await sql(`SELECT auto_pick_snake_pick_atomic(${q(room.draft)},${q(pick.member_id)},'manual')`)
    }
    const retry = async () => { for (const room of rooms) await sql(`SELECT * FROM process_expired_snake_pick_atomic(${q(room.draft)})`) }
    const auto = await expectRows('draft_auto_picked', freshScope(autoBefore), owners, retry)
    if (overall === 8) {
      const finished = await expectRows('draft_finished', roomScope(), rooms.flatMap(room => room.league.members), retry)
      await transport.prove(fixture, [...auto, ...finished], 'supabase/tests/db/notif-t9-draft.ts:115')
    } else await turns(clockBefore, soonBefore, retry, auto)
  }
  for (const room of rooms) await rejected(`SELECT auto_pick_snake_pick_atomic(${q(room.draft)},${q(room.league.members[0])},'manual')`)
  const rollover: OutboxRow[] = []
  for (const room of rooms) {
    const year = room.league.year + 1
    if (await sql(`SELECT count(*) FROM season_weeks WHERE season_year=${year}`) === '0') {
      fixture.years.push(year)
      await sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT ${year},week_number,week_start,week_end FROM season_weeks WHERE season_year=${room.league.year}`)
    }
    await sql(`UPDATE leagues SET status='archived' WHERE id=${q(room.league.id)}`)
    const next = JSON.parse(await sql(`SELECT row_to_json(r) FROM advance_season_atomic(${q(room.league.id)}) r`)) as { new_season_id: string; new_year: number }
    rollover.push(...await expectRows('season_rollover', `data->>'leagueSeasonId'=${q(next.new_season_id)}`, room.league.members, () => rejected(`SELECT * FROM advance_season_atomic(${q(room.league.id)})`)))
    room.league.season = next.new_season_id; room.league.year = next.new_year
  }
  await transport.prove(fixture, rollover, 'supabase/tests/db/notif-t9-draft.ts:131')
  for (const room of rooms) {
    room.draft = JSON.parse(await sql(`SELECT start_rookie_draft_atomic(${q(room.league.id)},1,false,60)`)).id
    await sql(`SELECT pause_draft_atomic(${q(room.draft)})`)
    await fixture.game(room.league.year, '2026-10-21', 1)
  }
  const autoBefore = await known('draft_auto_picked'), finishedBefore = await known('draft_finished')
  const backstop = () => sql("SELECT * FROM private.draft_timer_complete_opening_night(100,now())")
  await backstop()
  if ((await known('draft_resumed')).length) spurious.push('Opening-night completion broadcasts a human draft_resumed event')
  const auto = await expectRows('draft_auto_picked', freshScope(autoBefore), rooms.flatMap(room => room.league.members), backstop)
  const finished = await expectRows('draft_finished', freshScope(finishedBefore), rooms.flatMap(room => room.league.members), backstop)
  await transport.prove(fixture, [...auto, ...finished], 'supabase/tests/db/notif-t9-draft.ts:143')
  assert.deepEqual(spurious, [], 'Only an explicit resume action broadcasts draft_resumed')
  console.log('SYNTHETIC: real rookie sources, exact owners and foreign/non-member negatives, two human pause/resume cycles, two real auction absence/rejoin cycles, commissioner pick, normal pick, two rounds, rollover, paused opening-night backstop, source retries, all send-time switches and receipts')
} finally {
  await transport.close()
  await fixture.cleanup()
  await clock.restore()
}

import { strict as assert } from 'node:assert'
import path from 'node:path'
import { Clock, Fixture, Transport, expectRows, q, sql, type League, type OutboxRow } from './notif-t9-support.ts'

// Alternate release paths into watched_player_dropped. There is no automatic
// release: every waiver_wire_log insert comes from a claim drop, a trade's
// planned drop, or a manager drop (plain, drop-and-add, IR/taxi overflow).
const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
const file = 'supabase/tests/db/notif-t10-watch-drop.ts'
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const user = (member: string) => fixture.memberUsers.get(member)!
const asUser = (member: string, statement: string) => sql(`SELECT set_config('request.jwt.claim.sub',${q(user(member))},false); ${statement}`)
const scope = (player: string) => `data->>'playerId'=${q(player)}`
const others = (league: League, member: string) => league.members.filter(other => other !== member)
const own = (league: League, member: string, player: string, ir = false) =>
  sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir) VALUES(${q(league.id)},${q(league.season)},${q(member)},${q(player)},'draft',${ir}) RETURNING id`)
async function watched(league: League) {
  const player = await fixture.player()
  for (const member of league.members) await asUser(member, `SELECT notif_set_player_watch_atomic(${q(league.id)},${q(player)},true)`)
  return player
}
async function released(league: League, player: string, dropper: string) {
  assert.equal(await sql(`SELECT count(*) FROM roster_players WHERE league_id=${q(league.id)} AND player_id=${q(player)}`), '0', 'The watched player left the roster')
  assert.equal(await sql(`SELECT count(*) FROM waiver_wire_log WHERE league_id=${q(league.id)} AND player_id=${q(player)} AND dropped_by_member_id=${q(dropper)}`), '1', 'One release names the dropping member')
}
async function inactiveTrades(league: League, mode = 'disabled') {
  await sql(`UPDATE leagues SET trade_veto_mode=${q(mode)},trade_veto_window_hours=24 WHERE id=${q(league.id)}`)
  await asUser(league.members[0], `SELECT update_league_settings_atomic(${q(league.id)},'{"allow_inactive_trades":true}')`)
}
async function plannedTrade(league: League, recipient: string, proposer: string) {
  const give = await fixture.player(), get = await fixture.player(), dropped = await watched(league)
  await own(league, proposer, give)
  await own(league, recipient, get)
  await own(league, recipient, dropped)
  const trade = await sql(`SELECT propose_trade_atomic(${q(league.id)},${q(league.season)},${q(proposer)},${q(recipient)},ARRAY[${q(give)}]::uuid[],ARRAY[${q(get)}]::uuid[],'{}','{}')`)
  const accept = `SELECT accept_trade_with_plan_atomic(${q(trade)},${q(recipient)},${q(user(recipient))},'{}'::uuid[],'{}'::uuid[],ARRAY[${q(dropped)}]::uuid[])`
  await sql(accept)
  return { trade, dropped, accept }
}
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()

  const claims: { league: League; claimant: string; dropped: string; claim: string }[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league()
    const claimant = league.members[rotation], dropped = await watched(league), target = await fixture.player()
    await own(league, claimant, dropped)
    await sql(`INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at) VALUES(${q(league.id)},${q(league.season)},${q(target)},now()-interval '1 hour',now()+interval '47 hours')`)
    const claim = await sql(`SELECT create_waiver_claim_atomic(${q(league.id)},${q(claimant)},${q(target)},${q(dropped)},${q(user(claimant))},0,1)`)
    assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='watched_player_dropped' AND ${scope(dropped)}`), '0', 'A pending claim drop releases nobody yet')
    await sql(`UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute' WHERE league_id=${q(league.id)};
      UPDATE waiver_claims SET process_date=LEAST(current_date-1,${q(today)}::date-1) WHERE league_id=${q(league.id)};`)
    claims.push({ league, claimant, dropped, claim })
  }
  await transport.waivers()
  const replacement: OutboxRow[] = []
  for (const { league, claimant, dropped, claim } of claims) {
    assert.equal(await sql(`SELECT status FROM waiver_claims WHERE id=${q(claim)}`), 'succeeded')
    await released(league, dropped, claimant)
    replacement.push(...await expectRows('watched_player_dropped', scope(dropped), others(league, claimant), () => transport.waivers()))
  }
  await transport.prove(fixture, replacement, `${file}#waiver-replacement`, 'edge-http:process-waivers + trigger')

  const accepted: OutboxRow[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league()
    await inactiveTrades(league)
    const recipient = league.members[rotation]
    const { trade, dropped, accept } = await plannedTrade(league, recipient, league.members[(rotation + 1) % 4])
    assert.equal(await sql(`SELECT status FROM trades WHERE id=${q(trade)}`), 'completed', 'A disabled veto completes inside accept')
    await released(league, dropped, recipient)
    accepted.push(...await expectRows('watched_player_dropped', scope(dropped), others(league, recipient), () => assert.rejects(() => sql(accept), /pending/i)))
  }
  await transport.prove(fixture, accepted, `${file}#trade-accept`, 'sql-rpc:accept_trade_with_plan_atomic + trigger')

  const overflow: OutboxRow[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league()
    const owner = league.members[rotation], injured = await fixture.player(), freed = await watched(league)
    await sql(`UPDATE leagues SET roster_size=1 WHERE id=${q(league.id)}; UPDATE players SET injury_status='Out' WHERE id=${q(injured)};`)
    const injuredRoster = await own(league, owner, injured, true), freedRoster = await own(league, owner, freed)
    const activate = `SELECT activate_roster_player_with_overflow_atomic(${q(injuredRoster)},'ir',${q(freedRoster)},'drop')`
    await asUser(owner, activate)
    assert.equal(await sql(`SELECT is_on_ir FROM roster_players WHERE id=${q(injuredRoster)}`), 'f', 'The IR player was activated')
    await released(league, freed, owner)
    overflow.push(...await expectRows('watched_player_dropped', scope(freed), others(league, owner), () => assert.rejects(() => asUser(owner, activate))))
  }
  await transport.prove(fixture, overflow, `${file}#ir-overflow`, 'sql-rpc:activate_roster_player_with_overflow_atomic + trigger')

  const swapped: OutboxRow[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league()
    const owner = league.members[rotation], dropped = await watched(league), added = await fixture.player()
    const roster = await own(league, owner, dropped)
    const swap = `SELECT drop_and_add_free_agent_atomic(${q(roster)},${q(owner)},${q(league.id)},${q(added)})`
    await asUser(owner, swap)
    assert.equal(await sql(`SELECT member_id FROM roster_players WHERE league_id=${q(league.id)} AND player_id=${q(added)}`), owner)
    await released(league, dropped, owner)
    swapped.push(...await expectRows('watched_player_dropped', scope(dropped), others(league, owner), () => assert.rejects(() => asUser(owner, swap))))
  }
  await transport.prove(fixture, swapped, `${file}#drop-and-add`, 'sql-rpc:drop_and_add_free_agent_atomic + trigger')

  // The process-trades worker settles a vetoable trade and drains the outbox in
  // the same run, so its rows can never be pending when switches change: the
  // switches are set first and the observation says so (PRESET, not SPECIFIC).
  const vetoable: { league: League; recipient: string; dropped: string; trade: string }[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league()
    await inactiveTrades(league, 'commissioner')
    const recipient = league.members[rotation]
    const { trade, dropped } = await plannedTrade(league, recipient, league.members[(rotation + 1) % 4])
    assert.equal(await sql(`SELECT status FROM trades WHERE id=${q(trade)}`), 'accepted')
    assert.equal(await sql(`SELECT count(*) FROM waiver_wire_log WHERE player_id=${q(dropped)}`), '0', 'A planned drop waits for the veto window')
    await sql(`UPDATE trades SET veto_window_expires_at=now()-interval '1 second' WHERE id=${q(trade)}`)
    vetoable.push({ league, recipient, dropped, trade })
  }
  await sql(`UPDATE notification_preferences SET master_enabled=true,category_settings='{}',event_settings=(SELECT jsonb_object_agg(event_type,false) FROM notif_event_catalog)||'{"watched_player_dropped":true}'::jsonb WHERE user_id IN (${fixture.users.slice(0, 4).map(q)});
    UPDATE notification_preferences SET event_settings=event_settings||'{"watched_player_dropped":false}'::jsonb WHERE user_id=${q(fixture.users[0])};
    UPDATE notification_preferences SET category_settings='{"waiver":false}'::jsonb WHERE user_id=${q(fixture.users[1])};
    UPDATE notification_preferences SET master_enabled=false WHERE user_id=${q(fixture.users[2])};`)
  assert.equal(await sql(`SELECT category FROM notif_event_catalog WHERE event_type='watched_player_dropped'`), 'waiver')
  await transport.drain()
  const worker: OutboxRow[] = []
  for (const { league, recipient, dropped, trade } of vetoable) {
    assert.equal(await sql(`SELECT status FROM trades WHERE id=${q(trade)}`), 'completed', 'The process-trades worker settled the trade')
    await released(league, dropped, recipient)
    worker.push(...await expectRows('watched_player_dropped', scope(dropped), others(league, recipient), () => transport.drain()))
  }
  await fixture.negative(['watched_player_dropped'])
  let states: OutboxRow[] = []
  for (let pass = 0; pass < 40; pass++) {
    states = JSON.parse(await sql(`SELECT json_agg(row_to_json(o)) FROM notification_outbox o WHERE id IN (${worker.map(row => q(row.id))})`))
    if (states.every(row => row.suppressed_at || row.delivered_at)) break
    await transport.drain()
  }
  for (const row of states) {
    const attempts = transport.pushes.filter(push => push.data.outboxId === row.id)
    if (fixture.memberUsers.get(row.member_id) === fixture.users[3]) {
      assert.ok(row.delivered_at, 'control needs a fake receipt')
      assert.equal(attempts.length, 1, 'one transport attempt per control occurrence')
    } else {
      assert.equal(row.suppression_reason, 'preferences_disabled', JSON.stringify(row))
      assert.equal(attempts.length, 0)
    }
  }
  assert.deepEqual([...new Set(worker.map(row => fixture.users.indexOf(user(row.member_id))))].sort(), [0, 1, 2, 3])
  const observation = { event: 'watched_player_dropped', test: `${file}#trade-worker`, path: 'edge-http:process-trades (settles and dispatches in one run) + trigger', source: 'SPECIFIC', recipients: 'SPECIFIC', dedupe: 'SPECIFIC', optOut: { event: 'PRESET', category: 'PRESET', master: 'PRESET' }, sendTime: false, receipt: 'SPECIFIC', rows: worker.map(row => row.id) }
  console.log(JSON.stringify(observation))
  const folder = Deno.env.get('NOTIF_EVIDENCE')
  if (folder) {
    assert.ok(path.isAbsolute(folder) && !folder.startsWith(Deno.cwd() + '/'))
    await Deno.writeTextFile(path.join(folder, 'proof-observations.jsonl'), JSON.stringify(observation) + '\n', { append: true })
  }
  console.log('SYNTHETIC: watched_player_dropped through a waiver claim drop (process-waivers wrapper), a trade planned drop on accept and through the process-trades worker, IR overflow activation and drop-and-add; exact watchers minus the dropping member, foreign/non-member negatives, source retries, send-time switches and receipts')
} finally {
  try {
    await transport.close()
    await fixture.cleanup()
  } finally {
    await clock.restore()
  }
}

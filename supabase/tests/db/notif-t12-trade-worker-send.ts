import { strict as assert } from 'node:assert'
import './notif-t12-support.ts'
import { Clock, Fixture, Transport, expectRows, q, sql, type League, type OutboxRow } from './notif-t9-support.ts'

// watched_player_dropped through the process-trades worker, with every switch
// changed after the row exists. One worker run settles and then sends, but in
// separate transactions: process_due_accepted_trades_atomic commits the rows
// (index.ts:45), and only then does drainNotificationOutbox (index.ts:52) call
// claim_notification_outbox_atomic (index.ts:77), which reads preferences
// (claim_notification_outbox_atomic.sql:37-49,58) before notifyMembers reads
// them again (notificationDelivery.ts:326-349). Enqueue never reads them
// (notif_enqueue.sql). Two sections drive that gap:
//   held-claim: the run that settles is held at its own claim request while the
//     switches change, then released, so that same run must suppress.
//   next-run: a backlog whose delivery fails ends the settling run's drain
//     (outbox.ts:121), so the rows wait for the next worker run, the cron path
//     notification-dispatch-minute -> invoke_process_trades_if_due -> process-trades.
const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
const file = 'supabase/tests/db/notif-t12-trade-worker-send.ts'
const user = (member: string) => fixture.memberUsers.get(member)!
const asUser = (member: string, statement: string) => sql(`SELECT set_config('request.jwt.claim.sub',${q(user(member))},false); ${statement}`)
const scope = (player: string) => `data->>'playerId'=${q(player)}`
const others = (league: League, member: string) => league.members.filter(other => other !== member)
const own = (league: League, member: string, player: string) =>
  sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir) VALUES(${q(league.id)},${q(league.season)},${q(member)},${q(player)},'draft',false) RETURNING id`)
const settle = () => sql('SELECT count(*) FROM expire_pending_trades_atomic(50); SELECT count(*) FROM process_due_accepted_trades_atomic(50);')
const enableAll = () => sql(`UPDATE notification_preferences SET master_enabled=true,category_settings='{}',event_settings=(SELECT jsonb_object_agg(event_type,false) FROM notif_event_catalog)||'{"watched_player_dropped":true}'::jsonb WHERE user_id IN (${fixture.users.slice(0, 4).map(q)})`)
type Due = { league: League; recipient: string; dropped: string; trade: string }

// Four leagues, rotated so users 0-3 each hold every role, each with a vetoable
// planned-drop trade whose veto window has just ended.
async function dueTrades() {
  const due: Due[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league()
    await sql(`UPDATE leagues SET trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=${q(league.id)}`)
    await asUser(league.members[0], `SELECT update_league_settings_atomic(${q(league.id)},'{"allow_inactive_trades":true}')`)
    const recipient = league.members[rotation], proposer = league.members[(rotation + 1) % 4]
    const give = await fixture.player(), get = await fixture.player(), dropped = await fixture.player()
    for (const member of league.members) await asUser(member, `SELECT notif_set_player_watch_atomic(${q(league.id)},${q(dropped)},true)`)
    await own(league, proposer, give)
    await own(league, recipient, get)
    await own(league, recipient, dropped)
    const trade = await sql(`SELECT propose_trade_atomic(${q(league.id)},${q(league.season)},${q(proposer)},${q(recipient)},ARRAY[${q(give)}]::uuid[],ARRAY[${q(get)}]::uuid[],'{}','{}')`)
    await sql(`SELECT accept_trade_with_plan_atomic(${q(trade)},${q(recipient)},${q(user(recipient))},'{}'::uuid[],'{}'::uuid[],ARRAY[${q(dropped)}]::uuid[])`)
    assert.equal(await sql(`SELECT status FROM trades WHERE id=${q(trade)}`), 'accepted')
    assert.equal(await sql(`SELECT count(*) FROM waiver_wire_log WHERE player_id=${q(dropped)}`), '0', 'A planned drop waits for the veto window')
    await sql(`UPDATE trades SET veto_window_expires_at=now()-interval '1 second' WHERE id=${q(trade)}`)
    due.push({ league, recipient, dropped, trade })
  }
  return due
}

// The settling run already committed the trade, the release and the rows; the
// retry is the same settle call the worker makes, so it cannot claim anything.
async function settled(due: Due[]) {
  const batch: OutboxRow[] = []
  for (const { league, recipient, dropped, trade } of due) {
    assert.equal(await sql(`SELECT status FROM trades WHERE id=${q(trade)}`), 'completed', 'The worker settled the trade')
    assert.equal(await sql(`SELECT count(*) FROM roster_players WHERE league_id=${q(league.id)} AND player_id=${q(dropped)}`), '0')
    assert.equal(await sql(`SELECT count(*) FROM waiver_wire_log WHERE league_id=${q(league.id)} AND player_id=${q(dropped)} AND dropped_by_member_id=${q(recipient)}`), '1')
    batch.push(...await expectRows('watched_player_dropped', scope(dropped), others(league, recipient), settle))
  }
  const ids = batch.map(row => q(row.id))
  assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE id IN (${ids}) AND (claimed_at IS NOT NULL OR attempt_count>0 OR expo_ticket_id IS NOT NULL)`), '0', 'No claim has touched the rows yet')
  assert.equal(transport.pushes.filter(push => batch.some(row => row.id === push.data.outboxId)).length, 0)
  return batch
}

// Holds the next claim_notification_outbox_atomic request at the transport
// boundary. The first request to the worker after that (Transport.prove's first
// drain, which comes after it has changed the switches) releases the held run,
// waits for it and records what that run decided before the drain goes on.
class ClaimHold {
  state: 'idle' | 'armed' | 'held' = 'idle'
  ids: string[] = []
  decided: { id: string; member_id: string; suppression_reason: string | null; sent: boolean }[] = []
  reached = Promise.withResolvers<void>()
  release = Promise.withResolvers<void>()
  run: Promise<unknown> = Promise.resolve()
  install(worker: string) {
    const guarded = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (this.state === 'armed' && url.pathname === '/rest/v1/rpc/claim_notification_outbox_atomic') {
        this.state = 'held'
        this.reached.resolve()
        await this.release.promise
      } else if (this.state === 'held' && url.origin === worker) {
        this.state = 'idle'
        this.release.resolve()
        await this.run
        this.decided = JSON.parse(await sql(`SELECT json_agg(json_build_object('id',id,'member_id',member_id,'suppression_reason',suppression_reason,'sent',expo_ticket_id IS NOT NULL OR delivered_at IS NOT NULL)) FROM notification_outbox WHERE id IN (${this.ids.map(q)})`))
      }
      return guarded(input, init)
    }
  }
  arm(run: () => Promise<unknown>) {
    this.state = 'armed'
    this.run = run()
    this.run.catch(() => {})
    return Promise.race([this.reached.promise, this.run.then(() => assert.fail('The worker run ended before its claim request'))])
  }
  async abandon() {
    this.release.resolve()
    await this.run.catch(() => {})
  }
}

const hold = new ClaimHold()
let backlogUser = ''
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  hold.install(`http://127.0.0.1:${transport.worker!.addr.port}`)
  assert.equal(await sql(`SELECT category FROM notif_event_catalog WHERE event_type='watched_player_dropped'`), 'waiver')

  // held-claim. Every watcher is enabled when the rows are written, so only a
  // read after the switches change can suppress them.
  const held = await dueTrades()
  await enableAll()
  await hold.arm(() => transport.drain())
  const heldBatch = await settled(held)
  hold.ids = heldBatch.map(row => row.id)
  await transport.prove(fixture, heldBatch, `${file}#held-claim`, 'edge-http:process-trades (switches change between its settle and its own claim) + trigger')
  // The claim suppresses at most one batch of disabled rows per call, and the
  // trade's other (disabled) events share the frozen available_at, so the
  // settling run may leave some opted-out rows for prove's later drains. What it
  // must do is send every control row and none of the opted-out ones.
  assert.equal(hold.decided.length, heldBatch.length, 'The held run was released by the first proof drain')
  for (const row of hold.decided) {
    if (user(row.member_id) === fixture.users[3]) assert.ok(row.sent, 'The settling run itself sent the control row')
    else {
      assert.equal(row.sent, false, 'The settling run sent nothing after the switch changed')
      assert.ok(row.suppression_reason === null || row.suppression_reason === 'preferences_disabled', JSON.stringify(row))
    }
  }

  // next-run. A backlog ahead of the new rows, for a member with no push token,
  // fills the first claim and fails, which ends that run's drain.
  const { OUTBOX_CLAIM_LIMIT } = await import('../../functions/process-trades/outbox.ts')
  backlogUser = crypto.randomUUID()
  const backlogLeague = await fixture.league(), backlogMember = crypto.randomUUID()
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${q(backlogUser)},${q(backlogUser + '@example.test')},jsonb_build_object('username',${q(backlogUser)}));
    INSERT INTO notification_preferences(user_id,master_enabled,event_settings) VALUES(${q(backlogUser)},true,'{"commissioner_announcement":true}');
    INSERT INTO league_members(id,league_id,user_id,role) VALUES(${q(backlogMember)},${q(backlogLeague.id)},${q(backlogUser)},'manager');
    SELECT private.notif_enqueue('commissioner_announcement','notif-t12-backlog-'||n,${q(backlogLeague.id)},${q(backlogMember)},'{"body":"SYNTHETIC backlog"}') FROM generate_series(1,${OUTBOX_CLAIM_LIMIT}) n;
    UPDATE notification_outbox SET available_at=available_at-interval '1 minute' WHERE member_id=${q(backlogMember)};`)
  assert.equal(await sql(`SELECT count(*) FROM profiles WHERE id=${q(backlogUser)} AND push_token IS NULL`), '1')
  const next = await dueTrades()
  await enableAll()
  await transport.drain()
  assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE member_id=${q(backlogMember)} AND attempt_count=1 AND delivered_at IS NULL AND available_at>now()`), String(OUTBOX_CLAIM_LIMIT), 'The backlog filled the first claim and failed into its retry backoff')
  const nextBatch = await settled(next)
  await transport.prove(fixture, nextBatch, `${file}#next-run`, 'edge-http:process-trades (rows left by a run whose drain ended on a failed backlog) + trigger')
  await fixture.negative(['watched_player_dropped'])
  console.log('SYNTHETIC: watched_player_dropped from trade planned drops settled by the process-trades worker; the settling run held at its own claim while the event, category and master switches change, and rows left by a run that ended on a failed backlog sent by the next run; exact watchers minus the dropping member, foreign/non-member negatives, settle retries, send-time suppression and receipts')
} finally {
  try {
    await hold.abandon()
    await transport.close()
    await fixture.cleanup()
    if (backlogUser) await sql(`DELETE FROM auth.users WHERE id=${q(backlogUser)}; DELETE FROM profiles WHERE id=${q(backlogUser)};`)
  } finally {
    await clock.restore()
  }
}

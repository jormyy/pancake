import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, sql, type League, type OutboxRow } from './notif-t9-support.ts'

const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
type Offer = { id: string; retry: () => Promise<unknown> }
const leagues: League[] = []
async function offer(league: League, action = 'propose', source?: string, multi = false): Promise<Offer> {
  const actor = action === 'counter' ? league.members[2] : league.members[1]
  const payload = { leagueId: league.id, leagueSeasonId: league.season, recipientMemberId: league.members[2],
    tradeId: source, offerFaabAmount: 1, requestFaabAmount: 1, expiresAt: '2026-10-25T16:00:00Z',
    participantMemberIds: league.members.slice(1), items: league.members.slice(1).map((from, index, group) => ({ fromMemberId: from, toMemberId: group[(index + 1) % group.length], faabAmount: 1 })) }
  const request = crypto.randomUUID()
  const command = `SELECT submit_trade_offer_atomic(${q(fixture.memberUsers.get(actor)!)},${q(request)},${q(actor)},${q(action + (multi ? '-multi' : ''))},${q(JSON.stringify(payload))}::jsonb)`
  const id = await sql(command)
  return { id, retry: () => sql(command) }
}
const scope = (id: string) => `data->>'tradeId'=${q(id)}`
async function invalid(source: string) { await assert.rejects(() => sql(source), /not|pending|veto|complete|accepted|expired|ready/i) }
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league('active', rotation)
    await sql(`UPDATE leagues SET trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=${q(league.id)}`)
    leagues.push(league)
  }
  for (let occurrence = 0; occurrence < 2; occurrence++) {
    const batch: OutboxRow[] = []
    for (const league of leagues) {
      const trade = await offer(league)
      batch.push(...await expectRows('trade_offered', scope(trade.id), [league.members[2]], trade.retry))
    }
    await transport.prove(fixture, batch, 'supabase/tests/db/notif-t9-trade.ts:34')
  }
  for (const action of ['counter', 'edit']) {
    const batch: OutboxRow[] = []
    for (const league of leagues) {
      const base = await offer(league)
      const trade = await offer(league, action, base.id)
      batch.push(...await expectRows(action === 'counter' ? 'trade_countered' : 'trade_edited', scope(trade.id), [league.members[action === 'counter' ? 1 : 2]], trade.retry))
    }
    await transport.prove(fixture, batch, 'supabase/tests/db/notif-t9-trade.ts:43')
  }
  for (const action of ['rejected', 'withdrawn', 'expired', 'vetoed', 'completed', 'failed']) {
    const batch: OutboxRow[] = []
    for (const league of leagues) {
      const trade = await offer(league)
      const [commissioner, proposer, recipient] = league.members
      let event = 'trade_' + action
      let expected = [proposer, recipient]
      let retry: () => Promise<unknown>
      if (action === 'rejected') {
        const command = `SELECT reject_trade_atomic(${q(trade.id)},${q(recipient)},${q(fixture.memberUsers.get(recipient)!)})`
        await sql(command); retry = () => invalid(command); expected = [proposer]
      } else if (action === 'withdrawn') {
        const command = `SELECT withdraw_trade_atomic(${q(trade.id)},${q(proposer)},${q(fixture.memberUsers.get(proposer)!)})`
        await sql(command); retry = () => invalid(command); expected = [recipient]
      } else if (action === 'expired') {
        await sql(`UPDATE trades SET expires_at=now()-interval '1 second' WHERE id=${q(trade.id)}; SELECT * FROM expire_pending_trades_atomic(100);`)
        retry = () => sql('SELECT * FROM expire_pending_trades_atomic(100)')
      } else {
        await sql(`SELECT accept_trade_atomic(${q(trade.id)},${q(recipient)})`)
        if (action === 'vetoed') {
          const command = `SELECT veto_trade_atomic(${q(trade.id)},${q(commissioner)})`
          await sql(command); retry = () => invalid(command)
        } else {
          if (action === 'failed') await sql(`UPDATE faab_balances SET balance=0 WHERE league_id=${q(league.id)} AND member_id=${q(proposer)}`)
          await sql(`UPDATE trades SET veto_window_expires_at=now()-interval '1 second' WHERE id=${q(trade.id)}; SELECT * FROM process_due_accepted_trades_atomic(50);`)
          retry = () => sql('SELECT * FROM process_due_accepted_trades_atomic(50)')
          if (action === 'failed') {
            event = 'trade_completion_failed'
            await sql(`UPDATE faab_balances SET balance=100 WHERE league_id=${q(league.id)} AND member_id=${q(proposer)}`)
          } else batch.push(...await expectRows('league_trade', scope(trade.id), [commissioner, league.members[3]], retry))
        }
      }
      batch.push(...await expectRows(event, scope(trade.id), expected, retry!))
    }
    await transport.prove(fixture, batch, 'supabase/tests/db/notif-t9-trade.ts:79')
  }
  const partial: OutboxRow[] = [], accepted: OutboxRow[] = []
  for (const league of leagues) {
    const trade = await offer(league, 'propose', undefined, true)
    await sql(`SELECT accept_trade_atomic(${q(trade.id)},${q(league.members[2])})`)
    partial.push(...await expectRows('trade_participant_accepted', scope(trade.id), [league.members[1]], () => invalid(`SELECT accept_trade_atomic(${q(trade.id)},${q(league.members[2])})`)))
    await sql(`SELECT accept_trade_atomic(${q(trade.id)},${q(league.members[3])})`)
    accepted.push(...await expectRows('trade_accepted', scope(trade.id), [league.members[1], league.members[2]], () => invalid(`SELECT accept_trade_atomic(${q(trade.id)},${q(league.members[3])})`)))
  }
  await transport.prove(fixture, [...partial, ...accepted], 'supabase/tests/db/notif-t9-trade.ts:89')
  const cancelled: OutboxRow[] = []
  for (const league of leagues) {
    await sql(`SELECT set_config('request.jwt.claim.sub',${q(fixture.memberUsers.get(league.members[0])!)},false); SELECT update_league_settings_atomic(${q(league.id)},'{"allow_inactive_trades":true}')`)
    const from = await fixture.player(), to = await fixture.player(), target = await fixture.player()
    const proposer = league.members[1], recipient = league.members[2]
    await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${q(league.id)},${q(league.season)},${q(proposer)},${q(from)},'draft'),(${q(league.id)},${q(league.season)},${q(recipient)},${q(to)},'draft');
      INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,clears_at) VALUES(${q(league.id)},${q(league.season)},${q(target)},now()+interval '47 hours');`)
    const claim = await sql(`SELECT create_waiver_claim_atomic(${q(league.id)},${q(proposer)},${q(target)},${q(from)},${q(fixture.memberUsers.get(proposer)!)},1,1)`)
    const trade = await sql(`SELECT propose_trade_atomic(${q(league.id)},${q(league.season)},${q(proposer)},${q(recipient)},ARRAY[${q(from)}]::uuid[],ARRAY[${q(to)}]::uuid[],'{}','{}')`)
    await sql(`SELECT accept_trade_atomic(${q(trade)},${q(recipient)}); UPDATE trades SET veto_window_expires_at=now()-interval '1 second' WHERE id=${q(trade)}; SELECT * FROM process_due_accepted_trades_atomic(50);`)
    assert.equal(await sql(`SELECT status FROM waiver_claims WHERE id=${q(claim)}`), 'cancelled', await sql(`SELECT json_build_object('trade',to_jsonb(t),'roster',(SELECT json_agg(row_to_json(r)) FROM roster_players r WHERE r.league_id=t.league_id)) FROM trades t WHERE id=${q(trade)}`))
    cancelled.push(...await expectRows('trade_claim_cancelled', `data->>'claimId'=${q(claim)}`, [proposer], () => sql('SELECT * FROM process_due_accepted_trades_atomic(50)')))
  }
  await transport.prove(fixture, cancelled, 'supabase/tests/db/notif-t9-trade.ts:103')
  console.log('SYNTHETIC: real submit/reject/withdraw/expire/veto/accept/settlement paths, participant exclusions, multi-team partial acceptance, terminal failure, dependent waiver cancellation, occurrence retries, all switches and fake receipts')
} finally {
  await transport.close()
  await fixture.cleanup()
  await clock.restore()
}

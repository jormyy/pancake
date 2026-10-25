import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, rows, sql, type OutboxRow } from './notif-t9-support.ts'

const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  for (const bid of [5, 3]) {
    const batch: OutboxRow[] = []
    for (let rotation = 0; rotation < 4; rotation++) {
      const league = await fixture.league()
      const loser = league.members[(rotation + 1) % 4]
      const winner = league.members[rotation]
      const player = await fixture.player()
      await sql(`UPDATE leagues SET weekly_add_limit=1 WHERE id=${q(league.id)};
        UPDATE waiver_priorities SET priority=priority+10 WHERE league_id=${q(league.id)};
        UPDATE waiver_priorities SET priority=1 WHERE member_id=${q(winner)};
        UPDATE waiver_priorities SET priority=2 WHERE member_id=${q(loser)};
        INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at) VALUES(${q(league.id)},${q(league.season)},${q(player)},now()-interval '1 hour',now()+interval '47 hours');
        SELECT create_waiver_claim_atomic(${q(league.id)},${q(winner)},${q(player)},NULL,${q(fixture.memberUsers.get(winner)!)},5,1);
        SELECT create_waiver_claim_atomic(${q(league.id)},${q(loser)},${q(player)},NULL,${q(fixture.memberUsers.get(loser)!)},${bid},1);
        UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute' WHERE league_id=${q(league.id)};
        UPDATE waiver_claims SET process_date=current_date-1 WHERE league_id=${q(league.id)};
        UPDATE waiver_claims SET process_date=LEAST(process_date,${q(new Date().toISOString().slice(0,10))}::date-1) WHERE league_id=${q(league.id)};`)
      await transport.waivers()
      const claims = JSON.parse(await sql(`SELECT json_agg(row_to_json(c)) FROM waiver_claims c WHERE league_id=${q(league.id)}`)) as { id: string; member_id: string; status: string }[]
      const won = claims.find(claim => claim.member_id === winner)!
      const lost = claims.find(claim => claim.member_id === loser)!
      assert.equal(won.status, 'succeeded')
      assert.equal(lost.status, 'failed_priority')
      const retry = () => transport.waivers()
      const scope = `data->>'claimId'=${q(lost.id)}`
      batch.push(...await expectRows('waiver_claim_lost', scope, [loser], retry))
      if (bid === 5) assert.equal((await rows('faab_outbid', scope)).length, 0, 'An equal-bid priority loser was not outbid')
      else batch.push(...await expectRows('faab_outbid', scope, [loser], retry))
      assert.equal((await rows('faab_outbid', `data->>'claimId'=${q(won.id)}`)).length, 0, 'Winner cannot receive outbid')
      assert.equal((await rows('waiver_claim_lost', `data->>'claimId'=${q(won.id)}`)).length, 0, 'Winner cannot receive lost')
      batch.push(...await expectRows('waiver_claim_won', `data->>'claimId'=${q(won.id)}`, [winner], retry))
      batch.push(...await expectRows('waiver_limit_reached', `data->>'leagueSeasonId'=${q(league.season)}`, [winner], retry))
      batch.push(...await expectRows('waivers_processed', `data->>'leagueSeasonId'=${q(league.season)}`, [winner, loser], retry))
    }
    await transport.prove(fixture, batch, 'supabase/tests/db/notif-t9-faab.ts:43')
  }
  console.log('SYNTHETIC: real claim submission/settlement, equal and lower bids, winner/loser negatives, reprocessing dedupe, send-time switches and fake receipts')
} finally {
  await transport.close()
  await fixture.cleanup()
  await clock.restore()
}

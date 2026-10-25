import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, rows, sql, type League, type OutboxRow } from './notif-t9-support.ts'

// Waiver settlement variants the t9 FAAB recipe does not drive through the real
// process-waivers wrapper: rolling priority, full roster, exhausted weekly adds,
// a FAAB shortfall at settlement, and an unclaimed waiver expiry.
const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
const file = 'supabase/tests/db/notif-t10-waivers.ts'
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const retry = () => transport.waivers()
const user = (member: string) => fixture.memberUsers.get(member)!
const claimScope = (id: string) => `data->>'claimId'=${q(id)}`
async function onWaivers(league: League) {
  const player = await fixture.player()
  await sql(`INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at) VALUES(${q(league.id)},${q(league.season)},${q(player)},now()-interval '1 hour',now()+interval '47 hours')`)
  return player
}
const claim = (league: League, member: string, player: string, bid: number, order = 1) =>
  sql(`SELECT create_waiver_claim_atomic(${q(league.id)},${q(member)},${q(player)},NULL,${q(user(member))},${bid},${order})`)
async function priorities(league: League, first: string, second: string) {
  await sql(`UPDATE waiver_priorities SET priority=priority+10 WHERE league_id=${q(league.id)};
    UPDATE waiver_priorities SET priority=1 WHERE member_id=${q(first)};
    UPDATE waiver_priorities SET priority=2 WHERE member_id=${q(second)};`)
}
async function due(league: League) {
  await sql(`UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute' WHERE league_id=${q(league.id)};
    UPDATE waiver_claims SET process_date=LEAST(current_date-1,${q(today)}::date-1) WHERE league_id=${q(league.id)};`)
}
async function settled(id: string, status: string, reason: RegExp | null) {
  const row = JSON.parse(await sql(`SELECT json_build_object('status',status,'reason',failure_reason) FROM waiver_claims WHERE id=${q(id)}`)) as { status: string; reason: string | null }
  assert.equal(row.status, status, JSON.stringify(row))
  if (reason) assert.match(row.reason ?? '', reason)
  return row
}
async function lost(league: League, member: string, id: string, status: string, reason: RegExp) {
  const row = await settled(id, status, reason)
  const batch = await expectRows('waiver_claim_lost', claimScope(id), [member], retry)
  assert.equal(batch[0].data.body, row.reason, 'The loser sees the settlement reason')
  assert.equal((await rows('faab_outbid', claimScope(id))).length, 0, `${status} (${row.reason}) is not an outbid`)
  assert.equal((await rows('waiver_claim_won', claimScope(id))).length, 0, 'A failed claim cannot be won')
  return batch
}
async function won(member: string, id: string) {
  await settled(id, 'succeeded', null)
  assert.equal((await rows('waiver_claim_lost', claimScope(id))).length, 0, 'A winner cannot receive lost')
  assert.equal((await rows('faab_outbid', claimScope(id))).length, 0, 'A winner cannot receive outbid')
  return await expectRows('waiver_claim_won', claimScope(id), [member], retry)
}
const processed = (league: League, members: string[]) => expectRows('waivers_processed', `data->>'leagueSeasonId'=${q(league.season)}`, members, retry)
const noLimit = async (league: League) => assert.equal((await rows('waiver_limit_reached', `data->>'leagueSeasonId'=${q(league.season)}`)).length, 0, 'No weekly add limit was reached')
type Check = () => Promise<OutboxRow[]>
// Each variant becomes due and settles in its own phase, so one variant's
// proof drain never delivers another variant's still-unproven rows.
const checks: Record<string, Check[]> = { rolling: [], roster: [], limit: [], budget: [] }
const leagues: Record<string, League[]> = { rolling: [], roster: [], limit: [], budget: [] }
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  for (let rotation = 0; rotation < 4; rotation++) {
    {
      const league = await fixture.league()
      const first = league.members[rotation], second = league.members[(rotation + 1) % 4]
      await sql(`UPDATE leagues SET waiver_mode='rolling' WHERE id=${q(league.id)}`)
      await priorities(league, first, second)
      const player = await onWaivers(league)
      const winner = await claim(league, first, player, 0), loser = await claim(league, second, player, 0)
      leagues.rolling.push(league)
      checks.rolling.push(async () => {
        await noLimit(league)
        return [
          ...await won(first, winner),
          ...await lost(league, second, loser, 'failed_priority', /^Claimed by higher-priority team\.$/),
          ...await processed(league, [first, second]),
        ]
      })
    }
    {
      const league = await fixture.league()
      const full = league.members[rotation], open = league.members[(rotation + 1) % 4]
      await sql(`UPDATE leagues SET roster_size=1 WHERE id=${q(league.id)}`)
      await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${q(league.id)},${q(league.season)},${q(full)},${q(await fixture.player())},'draft')`)
      await priorities(league, full, open)
      const player = await onWaivers(league)
      const blocked = await claim(league, full, player, 5), winner = await claim(league, open, player, 1)
      leagues.roster.push(league)
      checks.roster.push(async () => [
        ...await lost(league, full, blocked, 'failed_roster', /^Roster full and no drop player specified\.$/),
        ...await won(open, winner),
        ...await processed(league, [full, open]),
      ])
    }
    {
      const league = await fixture.league()
      const member = league.members[rotation]
      await sql(`UPDATE leagues SET weekly_add_limit=1 WHERE id=${q(league.id)}`)
      const firstPlayer = await onWaivers(league), secondPlayer = await onWaivers(league)
      const firstClaim = await claim(league, member, firstPlayer, 0, 1), secondClaim = await claim(league, member, secondPlayer, 0, 2)
      leagues.limit.push(league)
      checks.limit.push(async () => [
        ...await won(member, firstClaim),
        ...await expectRows('waiver_limit_reached', `data->>'leagueSeasonId'=${q(league.season)}`, [member], retry),
        ...await lost(league, member, secondClaim, 'failed_roster', /^Weekly add limit reached /),
        ...await processed(league, [member]),
      ])
    }
    {
      const league = await fixture.league()
      const short = league.members[rotation], funded = league.members[(rotation + 1) % 4]
      await priorities(league, short, funded)
      const player = await onWaivers(league)
      const shortClaim = await claim(league, short, player, 5), winner = await claim(league, funded, player, 1)
      await sql(`UPDATE faab_balances SET balance=0 WHERE league_id=${q(league.id)} AND member_id=${q(short)}`)
      leagues.budget.push(league)
      checks.budget.push(async () => [
        ...await lost(league, short, shortClaim, 'failed_priority', /^Insufficient FAAB budget for this bid\.$/),
        ...await won(funded, winner),
        ...await processed(league, [short, funded]),
      ])
    }
  }
  const quiet = await fixture.league()
  const unclaimed = await onWaivers(quiet)
  const log = await sql(`SELECT id FROM waiver_wire_log WHERE player_id=${q(unclaimed)}`)
  for (const member of quiet.members) await sql(`SELECT set_config('request.jwt.claim.sub',${q(user(member))},false); SELECT notif_set_player_watch_atomic(${q(quiet.id)},${q(unclaimed)},true)`)
  for (const [variant, list] of Object.entries(checks)) {
    for (const league of leagues[variant]) await due(league)
    await transport.waivers()
    const batch: OutboxRow[] = []
    for (const check of list) batch.push(...await check())
    await transport.prove(fixture, batch, `${file}#${variant}`, 'edge-http:process-waivers + trigger')
  }
  await due(quiet)
  await transport.waivers()
  assert.notEqual(await sql(`SELECT cleared_at FROM waiver_wire_log WHERE id=${q(log)}`), '', 'expire_waiver_wire_logs cleared the unclaimed waiver through the wrapper')
  assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE data->>'playerId'=${q(unclaimed)} OR data->>'waiverLogId'=${q(log)}`), '0', 'An unclaimed waiver expiry has no notification producer, even for watchers')
  console.log('SYNTHETIC: real process-waivers wrapper for rolling priority, full-roster, exhausted weekly add and FAAB shortfall settlements, exact claimant recipients, no outbid for non-bid losses, reprocessing dedupe, all send-time switches and receipts, and a silent unclaimed expiry')
} finally {
  try {
    await transport.close()
    await fixture.cleanup()
  } finally {
    await clock.restore()
  }
}

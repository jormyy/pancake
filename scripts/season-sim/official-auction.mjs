import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fitsPosition } from './position-oracle.mjs'

export function officialAuctionPlan(players, profile) {
  const ids = new Set(players.map(row => row.id))
  assert.equal(ids.size, players.length, 'Auction pool identities must be unique')
  const pool = [...players].sort((a, b) => {
    const rank = row => createHash('sha256').update(`${profile.actionSeed}:${row.nba_id}`).digest('hex')
    return rank(a).localeCompare(rank(b))
  })
  const required = profile.teamCount * profile.settings.roster_size
  assert.ok(pool.length >= required, `Historical auction requires ${required} eligible players; found ${pool.length}`)
  const positions = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'UTIL', 'UTIL']
  const plan = [], used = new Set()
  for (let round = 0; round < profile.settings.roster_size; round++) {
    for (let team = 0; team < profile.teamCount; team++) {
      const slot = positions[round] ?? 'UTIL'
      const player = pool.find(row => !used.has(row.id) && fitsPosition(row, slot)) ?? pool.find(row => !used.has(row.id) && fitsPosition(row, 'UTIL'))
      assert.ok(player, `Historical auction pool needs another ${slot} for team ${team + 1}`)
      used.add(player.id)
      plan.push({ team, playerId: player.id, nbaId: player.nba_id, position: player.position, preferredSlot: slot, preferredSlotFilled: fitsPosition(player, slot), eligiblePositions: player.eligible_positions, round, bid: 88 - 4 * round })
    }
  }
  for (let team = 0; team < profile.teamCount; team++) assert.equal(plan.filter(row => row.team === team).reduce((sum, row) => sum + row.bid, 0), profile.auctionBudget)
  return plan
}

export async function runOfficialAuction(context, profile, move, now, read) {
  const { api, users, draftId, leagueId, leagueSeasonId } = context
  const pool = await read(`SELECT coalesce(json_agg(p ORDER BY nba_id),'[]') FROM (SELECT id,nba_id,position,eligible_positions FROM players WHERE nba_id IS NOT NULL AND nba_team IS NOT NULL AND position IS NOT NULL AND injury_status IS NULL AND status='Active') p`)
  const plan = officialAuctionPlan(pool, profile)
  const receipts = []
  for (const item of plan) {
    const state = await read(`SELECT json_build_object('draft',(SELECT row_to_json(d) FROM drafts d WHERE id='${draftId}'),'order',(SELECT json_agg(o ORDER BY position) FROM draft_orders o WHERE draft_id='${draftId}'))`)
    assert.equal(state.draft.status, 'in_progress', 'The auction remains active before each nomination')
    const position = ((state.draft.current_nomination_order - 1) % users.length) + 1
    const nominator = users.find(user => user.memberId === state.order.find(row => row.position === position)?.member_id)
    assert.ok(nominator, 'Current nomination belongs to a fictional manager')
    const { nomination } = await api(nominator, `/draft/${draftId}/nominate`, { memberId: nominator.memberId, playerId: item.playerId })
    const buyer = users[item.team]
    if (!receipts.length) await api(buyer, `/draft/${draftId}/bid`, { memberId: buyer.memberId, nominationId: nomination.id, amount: profile.auctionBudget + 1 }, 400)
    await api(buyer, `/draft/${draftId}/bid`, { memberId: buyer.memberId, nominationId: nomination.id, amount: item.bid })
    const deadline = await read(`SELECT to_json(countdown_expires_at) FROM nominations WHERE id='${nomination.id}'`)
    assert.ok(Number.isFinite(Date.parse(deadline)), 'An auction nomination has a server deadline')
    await move(Math.max(await now(), Date.parse(deadline) + 1000))
    await api(nominator, `/draft/${draftId}/close-expired`, {})
    const owner = await read(`SELECT coalesce(json_agg(r),'[]') FROM roster_players r WHERE league_season_id='${leagueSeasonId}' AND player_id='${item.playerId}'`)
    assert.equal(owner.length, 1, 'Each auction award has one owner')
    assert.equal(owner[0].member_id, buyer.memberId, 'Auction owner agrees with the independent bid plan')
    receipts.push({ ...item, memberId: buyer.memberId, nominationId: nomination.id, awardedAt: await now() })
  }
  const result = await read(`SELECT json_build_object('status',(SELECT status FROM drafts WHERE id='${draftId}'),'rosters',(SELECT json_agg(r) FROM (SELECT member_id,count(*) AS players FROM roster_players WHERE league_season_id='${leagueSeasonId}' AND NOT is_on_ir AND NOT is_on_taxi GROUP BY member_id) r),'budgets',(SELECT json_agg(b) FROM draft_budgets b WHERE draft_id='${draftId}'),'history',(SELECT count(*) FROM roster_transactions WHERE league_id='${leagueId}' AND league_season_id='${leagueSeasonId}' AND transaction_type='draft_won'))`)
  assert.equal(result.status, 'completed')
  assert.equal(result.rosters.length, profile.teamCount)
  for (const row of result.rosters) assert.equal(row.players, profile.settings.roster_size)
  for (const row of result.budgets) assert.equal(row.remaining, 0)
  assert.equal(result.history, plan.length, 'Every auction award leaves retained transaction history')
  return { passed: true, plan, receipts, budgets: result.budgets, players: result.history, eligibilityCoverage: { pool: pool.length, positions: Object.fromEntries([...new Set(pool.map(row => row.position))].sort().map(position => [position, pool.filter(row => row.position === position).length])), unfilledPreferredSlots: plan.filter(row => !row.preferredSlotFilled).map(({ team, preferredSlot }) => ({ team, preferredSlot })) } }
}

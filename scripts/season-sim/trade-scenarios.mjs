import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { season } from './common.mjs'
import { sql, sqlJson } from './local-stack.mjs'

export function tradeScenarios(c, report, move) {
  const [a, b] = c.users
  const settings = values => c.rpc(a, 'update_league_settings_atomic', { p_league_id: c.leagueId, p_settings: values })
  const propose = async (pickIds, expected = 200) => {
    const requested = await sql(`SELECT p.id FROM draft_picks p WHERE p.league_id='${c.leagueId}' AND p.season_year=${season.year + 4} AND p.current_owner_id='${b.memberId}' AND NOT p.is_used AND NOT EXISTS(SELECT 1 FROM trade_items i JOIN trades t ON t.id=i.trade_id WHERE i.pick_id=p.id AND t.status IN ('pending','accepted')) ORDER BY p.round LIMIT 1`)
    assert.ok(requested, 'Trade requires a real recipient asset')
    return c.api(a, '/trades/propose', { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: a.memberId, recipientMemberId: b.memberId, offerPickIds: pickIds, requestPickIds: [requested] }, expected)
  }
  return async date => {
    if (!report.tradeDeadline) {
      const deadline = date < `${c.seasonYear}-01-15` ? `${c.seasonYear}-01-15` : new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
      await settings({ trade_deadline: deadline, trade_veto_mode: 'disabled' })
      const picks = await sqlJson(`SELECT coalesce(json_agg(p ORDER BY season_year,round),'[]') FROM draft_picks p WHERE league_id='${c.leagueId}' AND current_owner_id='${a.memberId}' AND season_year IN (${season.year + 1},${season.year + 2}) AND round=1`, 'Pre-deadline pick assets')
      assert.equal(picks.length, 2, 'Trade both next-draft and future-season picks')
      const completed = await propose(picks.map(pick => pick.id))
      await c.api(b, `/trades/${completed.tradeId}/accept`, { memberId: b.memberId })
      const now = Number(await sql('SELECT extract(epoch FROM now())*1000'))
      await move(now + 6 * 60000)
      assert.equal(await sql(`SELECT status FROM trades WHERE id='${completed.tradeId}'`), 'completed', 'Accepted pre-deadline trade completes through the production trade gate')
      for (const pick of picks) assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${pick.id}'`), b.memberId, 'Completed trade transfers ownership')
      const pendingPick = await sql(`SELECT id FROM draft_picks WHERE league_id='${c.leagueId}' AND current_owner_id='${a.memberId}' AND season_year=${season.year + 3} AND round=1`)
      const pending = await propose([pendingPick])
      report.tradeDeadline = { deadline, completedTrade: completed.tradeId, pendingTrade: pending.tradeId, pendingPick, transferredPicks: picks.map(pick => ({ id: pick.id, owner: b.memberId, seasonYear: pick.season_year })), preDeadlinePassed: true }
      report.completed.push('Pre-deadline trade completes; next and future picks change owners')
    }
    const scenario = report.tradeDeadline
    if (date > scenario.deadline && !scenario.postDeadlinePassed) {
      const rejected = await propose([scenario.pendingPick], 400)
      assert.match(JSON.stringify(rejected), /deadline|champion|locked/i)
      const acceptance = await c.api(b, `/trades/${scenario.pendingTrade}/accept`, { memberId: b.memberId }, 400)
      assert.match(JSON.stringify(acceptance), /deadline|champion|locked/i)
      scenario.pendingStatus = await sql(`SELECT status FROM trades WHERE id='${scenario.pendingTrade}'`)
      assert.equal(scenario.pendingStatus, 'pending', 'A pending offer without an expiration stays pending but cannot be accepted after the deadline')
      scenario.postDeadlinePassed = true
      report.completed.push('Post-deadline proposal and acceptance fail through authenticated APIs; pending offer stays locked')
    }
  }
}

export async function completeOffseasonTrade(c, move) {
  const [a, b] = c.users
  const pickId = await sql(`SELECT id FROM draft_picks WHERE league_id='${c.leagueId}' AND season_year=${season.year + 2} AND round=3 AND current_owner_id='${a.memberId}' AND NOT is_used ORDER BY id LIMIT 1`)
  assert.ok(pickId, 'Offseason trade requires a real unused future pick')
  const requested = await sql(`SELECT id FROM draft_picks WHERE league_id='${c.leagueId}' AND season_year=${season.year + 3} AND round=3 AND current_owner_id='${b.memberId}' AND NOT is_used ORDER BY id LIMIT 1`)
  assert.ok(requested, 'Offseason trade requires a recipient asset')
  const proposed = await c.api(a, '/trades/propose', { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: a.memberId, recipientMemberId: b.memberId, offerPickIds: [pickId], requestPickIds: [requested] })
  await c.api(b, `/trades/${proposed.tradeId}/accept`, { memberId: b.memberId })
  const now = Number(await sql('SELECT extract(epoch FROM now())*1000'))
  await move(now + 6 * 60000)
  assert.equal(await sql(`SELECT status FROM trades WHERE id='${proposed.tradeId}'`), 'completed')
  assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${pickId}'`), b.memberId, 'Offseason pick trade transfers ownership through production processing')
  assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${requested}'`), a.memberId, 'Offseason pick trade transfers the counterparty asset')
  return { tradeId: proposed.tradeId, pickId, owner: b.memberId, counterPickId: requested, counterOwner: a.memberId, passed: true }
}

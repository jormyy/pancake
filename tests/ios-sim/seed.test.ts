import assert from 'node:assert/strict'
import { test } from 'vitest'
import * as fixture from '../../scripts/ios-sim/seed.mjs'

function database() {
  const settings: Record<string, unknown> = {}
  const proposals: { name: string, args: Record<string, unknown> }[] = []
  let existing: { id: string } | null = null
  const client = {
    from(table: string) {
      const query = {
        update(value: object) { assert.equal(table, 'leagues'); Object.assign(settings, value); return query },
        select() { return query },
        eq() { return query },
        async maybeSingle() { return { data: existing, error: null } },
        then(resolve: (value: object) => void) { resolve({ data: null, error: null }) },
      }
      return query
    },
    async rpc(name: string, args: Record<string, unknown>) {
      proposals.push({ name, args })
      existing = { id: 'roster-plan-trade' }
      return { data: existing.id, error: null }
    },
  }
  return { client, settings, proposals }
}

test('the roster-plan fixture preserves rosters and creates an incoming overflow with a taxi rookie', async () => {
  const db = database()
  const members = Array.from({ length: 10 }, (_, index) => ({ id: `member-${index}` }))
  const players = Array.from({ length: 260 }, (_, index) => ({ id: `player-${index}`, years_exp: index % 22 === 21 ? 0 : 4, nba_draft_number: index % 22 === 21 ? 1 : null }))
  const input = { leagueId: 'league', seasonId: 'season', members, players }
  const before = JSON.stringify(input)
  const trade = await fixture.seedRosterPlanTrade(db.client, input)
  assert.equal(JSON.stringify(input), before)
  assert.equal(db.settings.allow_inactive_trades, true)
  assert.equal(db.proposals.length, 1)
  const proposal = db.proposals[0]
  assert.equal(proposal.name, 'propose_trade_atomic')
  assert.equal(proposal.args.p_recipient_member_id, members[trade.manager].id)
  const incoming = proposal.args.p_offer_player_ids as string[]
  const outgoing = proposal.args.p_request_player_ids as string[]
  const rookie = players.find(player => player.id === trade.rookiePlayerId)!
  assert.equal(rookie.years_exp, 0)
  assert.ok(rookie.nba_draft_number)
  assert.ok(incoming.includes(rookie.id))
  const incomingActive = incoming.filter(id => id !== rookie.id).length
  assert.equal(20 + incomingActive - outgoing.length, 21)
  assert.equal(20 + incomingActive - outgoing.length - 1, 20)
  assert.ok(![...incoming, ...outgoing].includes(trade.dropPlayerId))
  assert.equal(trade.dropPlayerId, players[trade.manager * 22 + 18].id)
  assert.equal((await fixture.seedRosterPlanTrade(db.client, input)).id, trade.id)
  assert.equal(db.proposals.length, 1)
})

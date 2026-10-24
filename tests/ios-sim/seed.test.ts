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

test('an auction capture removes its nomination when the check fails', async () => {
  const nominations: any[] = [{ id: 'closed', status: 'won', nomination_order: 2 }]
  const before = JSON.stringify(nominations)
  const admin = {
    from(table: string) {
      assert.equal(table, 'nominations')
      let inserting: any, removing = false
      const query = {
        select() { return query },
        eq(_key: string, value: string) {
          if (removing) nominations.splice(nominations.findIndex(row => row.id === value), 1)
          return query
        },
        insert(row: object) { inserting = { ...row, id: 'capture', status: 'open' }; return query },
        delete() { removing = true; return query },
        async single() { nominations.push(inserting); return { data: inserting, error: null } },
        then(resolve: (value: object) => void) { resolve({ data: [...nominations], error: null }) },
      }
      return query
    },
  }
  await assert.rejects(fixture.withAuctionNomination(admin, { draftId: 'auction', memberId: 'leader', playerId: 'free-agent' }, async () => {
    const open = nominations.find(row => row.status === 'open')!
    assert.equal(open.draft_id, 'auction')
    assert.equal(open.player_id, 'free-agent')
    assert.equal(open.current_bidder_id, 'leader')
    assert.equal(open.nomination_order, 3)
    assert.ok(Date.parse(open.countdown_expires_at) > Date.now() + 3500000)
    throw new Error('Missing bid control')
  }), /Missing bid control/)
  assert.equal(JSON.stringify(nominations), before)
})

test.each([false, true])('an IR capture restores injuries after success or failure: %s', async fail => {
  const players = [{ id: 'ir-player', injury_status: 'Out' as string | null }, { id: 'other-player', injury_status: 'Doubtful' as string | null }]
  const before = JSON.stringify(players)
  const admin = {
    from(table: string) {
      const filters = new Map<string, unknown>()
      let update: { injury_status: string | null } | undefined
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters.set(key, value); return query },
        in(key: string, value: unknown[]) { filters.set(key, value); return query },
        update(value: { injury_status: string | null }) { update = value; return query },
        then(resolve: (value: object) => void) {
          if (table === 'roster_players') {
            assert.equal(filters.get('member_id'), 'manager')
            assert.equal(filters.get('league_season_id'), 'season')
            assert.equal(filters.get('is_on_ir'), true)
            resolve({ data: [{ player_id: 'ir-player' }], error: null })
          } else {
            assert.equal(table, 'players')
            const ids = filters.get('id')
            const matching = players.filter(player => Array.isArray(ids) ? ids.includes(player.id) : player.id === ids)
            const data = matching.map(player => ({ ...player }))
            if (update) for (const player of matching) Object.assign(player, update)
            resolve({ data, error: null })
          }
        },
      }
      return query
    },
  }
  const capture = () => fixture.withHealthyIRPlayer(admin, { memberId: 'manager', seasonId: 'season' }, async () => {
    assert.equal(players[0].injury_status, null)
    assert.equal(players[1].injury_status, 'Doubtful')
    if (fail) throw new Error('Capture failed')
    return 'captured'
  })
  if (fail) await assert.rejects(capture(), /Capture failed/)
  else assert.equal(await capture(), 'captured')
  assert.equal(JSON.stringify(players), before)
})

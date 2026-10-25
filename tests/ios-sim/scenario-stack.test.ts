import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { test } from 'vitest'
import { connectStack } from '../../scripts/ios-sim/stack.mjs'
import { withScenarioSetup } from '../../scripts/ios-sim/seed.mjs'

test.skipIf(process.env.IOS_SIM_SHARED_FIXTURES !== '1')('scenario fixtures create real state and clean up after a capture fails', async () => {
  const stack = await connectStack()
  const admin = createClient(stack.url, stack.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const fixture = stack.fixture
  assert.equal(fixture.startupAuctionCompleted, true)
  const memberId = fixture.members[0].id
  const playerId = fixture.players[230].id
  const data = async (operation: any) => { const { data, error } = await operation; if (error) throw error; return data }
  const roster = () => data(admin.from('roster_players').select('id,player_id,is_on_ir,is_on_taxi').eq('member_id', memberId).order('id'))
  const snapshot = async () => ({
    roster: await roster(),
    counts: await data(admin.from('weekly_add_counts').select('*').eq('member_id', memberId).eq('league_season_id', fixture.seasonId).order('week_number')),
    league: await data(admin.from('leagues').select('roster_size,status').eq('id', fixture.leagueId).single()),
    lineups: await data(admin.from('weekly_lineups').select('id,player_id,game_date,slot_type').eq('member_id', memberId).order('id')),
    players: await data(admin.from('players').select('id,injury_status,years_exp,nba_draft_number').in('id', [playerId, fixture.players[18].id]).order('id')),
    drafts: await data(admin.from('drafts').select('id,draft_type,status,completed_at').eq('league_id', fixture.leagueId).eq('is_mock', false).order('id')),
    nominations: await data(admin.from('nominations').select('id,current_bidder_id,current_bid_amount').eq('draft_id', fixture.drafts.find((draft: any) => draft.draft_type === 'auction').id).order('id')),
    waivers: await data(admin.from('waiver_wire_log').select('id,clears_at,cleared_at').eq('player_id', playerId).eq('league_id', fixture.leagueId).order('id')),
  })
  const before = await snapshot()
  assert.equal(before.league.status, 'active')
  const startup = before.drafts.filter((draft: any) => draft.draft_type === 'auction')
  assert.equal(startup.length, 1)
  assert.equal(startup[0].status, 'completed')
  assert.ok(startup[0].completed_at)
  const capture = async (setup: object, verify: () => Promise<void>) => {
    await assert.rejects(withScenarioSetup(stack, setup, async () => { await verify(); throw new Error('Capture failed') }), /Capture failed/)
    assert.deepEqual(await snapshot(), before)
  }
  await capture({ rosterLimit: 19 }, async () => {
    assert.equal((await data(admin.from('leagues').select('roster_size,status').eq('id', fixture.leagueId).single())).roster_size, 19)
  })
  assert.equal((await data(admin.from('leagues').select('roster_size,status').eq('id', fixture.leagueId).single())).roster_size, 20)
  await capture({ activationMember: memberId }, async () => {
    const rows = (await data(admin.from('weekly_lineups').select('slot_type,game_date').eq('member_id', memberId)))
      .filter((row: any) => new Date(`${row.game_date}T12:00:00Z`).getUTCDay() === 0)
    assert.equal(rows.length, 9)
    assert.ok(rows.every((row: any) => row.slot_type !== 'SG'))
  })
  await capture({ waiverAwardMember: memberId, waiverPlayer: playerId }, async () => {
    const rows = await roster()
    assert.ok(rows.some((row: any) => row.player_id === playerId && !row.is_on_ir && !row.is_on_taxi))
  })
  await capture({ waiverClaimMember: memberId, waiverPlayer: playerId }, async () => {
    assert.equal((await data(admin.from('players').select('injury_status').eq('id', playerId).single())).injury_status, 'Out')
  })
  await capture({ tradePlan: true }, async () => {
    assert.equal((await data(admin.from('players').select('years_exp').eq('id', fixture.players[18].id).single())).years_exp, 0)
  })
  await capture({ liveAuctionLeader: memberId }, async () => {
    assert.equal((await data(admin.from('leagues').select('status').eq('id', fixture.leagueId).single())).status, 'drafting')
    const row = await data(admin.from('nominations').select('current_bidder_id,player_id').eq('draft_id', fixture.drafts.find((draft: any) => draft.draft_type === 'auction').id).eq('status', 'open').single())
    assert.equal(row.current_bidder_id, memberId)
    const drafts = await data(admin.from('drafts').select('draft_type,status').eq('league_id', fixture.leagueId).eq('is_mock', false))
    assert.ok(drafts.filter((draft: any) => draft.status === 'in_progress').every((draft: any) => draft.draft_type === 'auction'))
    const player = await data(admin.from('players').select('years_exp').eq('id', row.player_id).single())
    assert.equal(player.years_exp, 0)
  })
}, 30000)

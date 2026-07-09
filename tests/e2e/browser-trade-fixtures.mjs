import { setupTradeGameplayFixture } from './trade-fixture.mjs'

export const setupTradeAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'pending',
      notes: 'Browser trade accept gameplay',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`trade fixture insert: ${tradeError.message}`)

  const { error: itemError } = await fixture.admin.from('trade_items').insert([
    {
      trade_id: trade.id,
      side: 'proposer',
      player_id: fixture.proposerPlayer.id,
      pick_id: null,
    },
    {
      trade_id: trade.id,
      side: 'recipient',
      player_id: fixture.recipientPlayer.id,
      pick_id: null,
    },
  ])
  if (itemError) throw new Error(`trade item fixture insert: ${itemError.message}`)

  return { ...fixture, trade }
}

export const setupTradeFuturePickAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'pending',
      notes: 'Browser future-pick accept gameplay',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`future-pick trade fixture insert: ${tradeError.message}`)

  const { error: itemError } = await fixture.admin.from('trade_items').insert([
    {
      trade_id: trade.id,
      side: 'proposer',
      player_id: null,
      pick_id: fixture.proposerFuturePick.id,
    },
    {
      trade_id: trade.id,
      side: 'recipient',
      player_id: null,
      pick_id: fixture.recipientFuturePick.id,
    },
  ])
  if (itemError) throw new Error(`future-pick trade item fixture insert: ${itemError.message}`)

  return { ...fixture, trade }
}

export const setupTradeOverflowAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const { error: leagueError } = await fixture.admin
    .from('leagues')
    .update({ roster_size: 1 })
    .eq('id', fixture.league.id)
  if (leagueError) throw new Error(`overflow league roster_size update: ${leagueError.message}`)

  const { data: recipientRoster, error: rosterError } = await fixture.admin
    .from('roster_players')
    .select('id, member_id, player_id')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.recipient.id)
    .eq('player_id', fixture.recipientPlayer.id)
    .single()
  if (rosterError) throw new Error(`overflow recipient roster lookup: ${rosterError.message}`)

  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'pending',
      notes: 'Browser trade overflow accept gameplay',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`overflow trade fixture insert: ${tradeError.message}`)

  const { error: itemError } = await fixture.admin.from('trade_items').insert([
    {
      trade_id: trade.id,
      side: 'proposer',
      player_id: fixture.proposerPlayer.id,
      pick_id: null,
    },
    {
      trade_id: trade.id,
      side: 'recipient',
      player_id: null,
      pick_id: fixture.recipientFuturePick.id,
    },
  ])
  if (itemError) throw new Error(`overflow trade item fixture insert: ${itemError.message}`)

  return {
    ...fixture,
    trade,
    rosterSize: 1,
    dropCandidateRosterId: recipientRoster.id,
  }
}

export const setupTradeVetoGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season, { memberCount: 3 })
  if (!fixture.observer) throw new Error('browser trade veto fixture did not create observer member')

  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      veto_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      notes: 'Browser trade veto gameplay',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`veto trade fixture insert: ${tradeError.message}`)

  const { error: itemError } = await fixture.admin.from('trade_items').insert([
    {
      trade_id: trade.id,
      side: 'proposer',
      player_id: fixture.proposerPlayer.id,
      pick_id: null,
    },
    {
      trade_id: trade.id,
      side: 'recipient',
      player_id: fixture.recipientPlayer.id,
      pick_id: null,
    },
  ])
  if (itemError) throw new Error(`veto trade item fixture insert: ${itemError.message}`)

  return { ...fixture, trade, observer: fixture.observer }
}

export const setupTradePostDeadlineGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const tradeDeadline = '2000-01-01'
  const { error } = await fixture.admin
    .from('leagues')
    .update({ trade_deadline: tradeDeadline })
    .eq('id', fixture.league.id)
  if (error) throw new Error(`post-deadline trade fixture update: ${error.message}`)
  return { ...fixture, tradeDeadline }
}



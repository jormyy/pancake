import { findAvailablePlayers, setupTradeGameplayFixture } from './trade-fixture.mjs'

/**
 * @template {{ dispose: () => Promise<void> }} Fixture
 * @template Result
 * @param {Fixture} fixture
 * @param {() => Promise<Result>} build
 */
const extendFixture = async (fixture, build) => {
  try {
    return await build()
  } catch (error) {
    try {
      await fixture.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Trade child fixture setup and cleanup failed')
    }
    throw error
  }
}

/**
 * @param {Awaited<ReturnType<typeof setupTradeGameplayFixture>>} fixture
 * @param {string} tradeId
 * @param {boolean} [recipientAccepted]
 */
const seedTradeParticipants = async (fixture, tradeId, recipientAccepted = false) => {
  const acceptedAt = new Date().toISOString()
  const { error } = await fixture.admin.from('trade_participants').insert([
    {
      trade_id: tradeId,
      member_id: fixture.proposer.id,
      sort_order: 0,
      is_initiator: true,
      accepted_at: acceptedAt,
    },
    {
      trade_id: tradeId,
      member_id: fixture.recipient.id,
      sort_order: 1,
      is_initiator: false,
      accepted_at: recipientAccepted ? acceptedAt : null,
    },
  ])
  if (error) throw new Error(`trade participant fixture insert: ${error.message}`)
}

/**
 * @param {Awaited<ReturnType<typeof setupTradeGameplayFixture>>} fixture
 * @param {{
 *   status?: 'pending' | 'accepted', notes: string, recipientAccepted?: boolean,
 *   acceptedAt?: string, vetoWindowExpiresAt?: string,
 *   items: { side: 'proposer' | 'recipient', player_id: string | null, pick_id: string | null }[]
 * }} seed
 */
const seedTrade = async (fixture, seed) => {
  const { data: trade, error: tradeError } = await fixture.admin.from('trades').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    proposer_member_id: fixture.proposer.id,
    recipient_member_id: fixture.recipient.id,
    status: seed.status ?? 'pending',
    accepted_at: seed.acceptedAt ?? null,
    veto_window_expires_at: seed.vetoWindowExpiresAt ?? null,
    notes: seed.notes,
  }).select('id').single()
  if (tradeError) throw new Error(`trade fixture insert: ${tradeError.message}`)
  await seedTradeParticipants(fixture, trade.id, seed.recipientAccepted)
  const { error: itemError } = await fixture.admin.from('trade_items').insert(
    seed.items.map((item) => ({
      ...item,
      trade_id: trade.id,
      from_member_id: item.side === 'proposer' ? fixture.proposer.id : fixture.recipient.id,
      to_member_id: item.side === 'proposer' ? fixture.recipient.id : fixture.proposer.id,
    })),
  )
  if (itemError) throw new Error(`trade item fixture insert: ${itemError.message}`)
  return trade
}

/** @param {Parameters<typeof setupTradeGameplayFixture>[0]} env @param {number} season */
export const setupTradeAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  return extendFixture(fixture, async () => {
    if (!fixture.proposerFuturePick || !fixture.recipientFuturePick) {
      throw new Error('future-pick fixture requires both teams to own a future pick')
    }
    const trade = await seedTrade(fixture, {
      notes: 'Browser trade accept gameplay',
      items: [
        { side: 'proposer', player_id: fixture.proposerPlayer.id, pick_id: null },
        { side: 'recipient', player_id: fixture.recipientPlayer.id, pick_id: null },
      ],
    })
    return {
      ...fixture,
      proposerFuturePick: fixture.proposerFuturePick,
      recipientFuturePick: fixture.recipientFuturePick,
      trade,
    }
  })
}

/** @param {Parameters<typeof setupTradeGameplayFixture>[0]} env @param {number} season */
export const setupTradeFuturePickAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  return extendFixture(fixture, async () => {
    if (!fixture.proposerFuturePick || !fixture.recipientFuturePick) {
      throw new Error('future-pick fixture requires both teams to own a future pick')
    }
    const trade = await seedTrade(fixture, {
      notes: 'Browser future-pick accept gameplay',
      items: [
        { side: 'proposer', player_id: null, pick_id: fixture.proposerFuturePick.id },
        { side: 'recipient', player_id: null, pick_id: fixture.recipientFuturePick.id },
      ],
    })
    return {
      ...fixture,
      proposerFuturePick: fixture.proposerFuturePick,
      recipientFuturePick: fixture.recipientFuturePick,
      trade,
    }
  })
}

/** @param {Parameters<typeof setupTradeGameplayFixture>[0]} env @param {number} season */
export const setupTradeOverflowAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  return extendFixture(fixture, async () => {
    if (!fixture.recipientFuturePick) throw new Error('overflow fixture requires a recipient future pick')
    const [freeAgentPlayer] = await findAvailablePlayers(
      fixture.admin,
      fixture.league.id,
      fixture.currentSeason.id,
      1,
      fixture.registerCreatedPlayer,
    )
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

    const trade = await seedTrade(fixture, {
      notes: 'Browser trade overflow accept gameplay',
      items: [
        { side: 'proposer', player_id: fixture.proposerPlayer.id, pick_id: null },
        { side: 'recipient', player_id: null, pick_id: fixture.recipientFuturePick.id },
      ],
    })
    return {
      ...fixture,
      recipientFuturePick: fixture.recipientFuturePick,
      trade,
      rosterSize: 1,
      dropCandidateRosterId: recipientRoster.id,
      freeAgentPlayer,
    }
  })
}

/** @param {Parameters<typeof setupTradeGameplayFixture>[0]} env @param {number} season */
export const setupTradeVetoGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season, { memberCount: 3 })
  return extendFixture(fixture, async () => {
    if (!fixture.observer) throw new Error('browser trade veto fixture did not create observer member')
    const acceptedAt = new Date().toISOString()
    const trade = await seedTrade(fixture, {
      status: 'accepted',
      acceptedAt,
      vetoWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      recipientAccepted: true,
      notes: 'Browser trade veto gameplay',
      items: [
        { side: 'proposer', player_id: fixture.proposerPlayer.id, pick_id: null },
        { side: 'recipient', player_id: fixture.recipientPlayer.id, pick_id: null },
      ],
    })
    return { ...fixture, trade, observer: fixture.observer }
  })
}

/** @param {Parameters<typeof setupTradeGameplayFixture>[0]} env @param {number} season */
export const setupTradePostDeadlineGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  return extendFixture(fixture, async () => {
    const tradeDeadline = '2000-01-01'
    const { error } = await fixture.admin
      .from('leagues')
      .update({ trade_deadline: tradeDeadline })
      .eq('id', fixture.league.id)
    if (error) throw new Error(`post-deadline trade fixture update: ${error.message}`)
    return { ...fixture, tradeDeadline }
  })
}

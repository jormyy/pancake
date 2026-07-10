/** @typedef {Awaited<ReturnType<typeof import('./trade-fixture.mjs').setupTradeGameplayFixture>>} BaseFixture */
/** @typedef {BaseFixture & { trade: { id: string } }} TradeFixture */
/** @typedef {BaseFixture & { proposerFuturePick: NonNullable<BaseFixture['proposerFuturePick']>, recipientFuturePick: NonNullable<BaseFixture['recipientFuturePick']> }} FuturePickFixture */
/** @typedef {TradeFixture & FuturePickFixture} FuturePickTradeFixture */
/** @typedef {TradeFixture & { recipientFuturePick: NonNullable<BaseFixture['recipientFuturePick']>, rosterSize: number, dropCandidateRosterId: string, freeAgentPlayer: { id: string } }} OverflowTradeFixture */
/** @typedef {TradeFixture & { observer: NonNullable<BaseFixture['observer']> }} VetoTradeFixture */

/** @param {BaseFixture} fixture */
export const verifyTradeProposal = async (fixture) => {
  const { data: trades, error: tradesError } = await fixture.admin
    .from('trades')
    .select('id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, notes')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('proposer_member_id', fixture.proposer.id)
    .eq('recipient_member_id', fixture.recipient.id)
    .eq('status', 'pending')
  if (tradesError) throw new Error(`trade verify: ${tradesError.message}`)

  const failures = []
  if ((trades ?? []).length !== 1) {
    failures.push(`pending trade rows=${(trades ?? []).length}; expected 1`)
  }
  const trade = trades?.[0] ?? null
  if (!trade) return { trade, items: [], failures }

  const { data: items, error: itemsError } = await fixture.admin
    .from('trade_items')
    .select('id, trade_id, side, player_id, pick_id')
    .eq('trade_id', trade.id)
    .order('side', { ascending: true })
  if (itemsError) throw new Error(`trade item verify: ${itemsError.message}`)

  const proposerItem = (items ?? []).find((item) => item.side === 'proposer')
  const recipientItem = (items ?? []).find((item) => item.side === 'recipient')
  if ((items ?? []).length !== 2) failures.push(`trade_items rows=${(items ?? []).length}; expected 2`)
  if (proposerItem?.player_id !== fixture.proposerPlayer.id) {
    failures.push(`proposer item player=${proposerItem?.player_id}; expected ${fixture.proposerPlayer.id}`)
  }
  if (recipientItem?.player_id !== fixture.recipientPlayer.id) {
    failures.push(`recipient item player=${recipientItem?.player_id}; expected ${fixture.recipientPlayer.id}`)
  }
  if ((items ?? []).some((item) => item.pick_id != null)) failures.push('player-for-player trade unexpectedly inserted pick items')
  return { trade, items: items ?? [], failures }
}

/** @param {BaseFixture} fixture @param {number} [timeoutMs] */
export const waitForTradeProposal = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeProposal(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeProposal(fixture)
  }
  return last
}

/**
 * @typedef {{
 *   initialTradeId: string, sourceStatus: 'edited' | 'countered',
 *   sourceColumn: 'edited_from_trade_id' | 'countered_from_trade_id',
 *   expectedProposerId: string, expectedRecipientId: string, expectedVersion: number,
 *   expectedPlayerIds: string[], expectedPickIds: string[]
 * }} ReplacementExpectation
 */
/** @param {BaseFixture} fixture @param {string} sourceTradeId @param {ReplacementExpectation} expected */
const verifyTradeReplacement = async (fixture, sourceTradeId, expected) => {
  const { data: source, error: sourceError } = await fixture.admin.from('trades')
    .select('id, status, replaced_by_trade_id')
    .eq('id', sourceTradeId)
    .single()
  if (sourceError) throw new Error(`trade replacement source verify: ${sourceError.message}`)
  const failures = []
  if (source.status !== expected.sourceStatus) failures.push(`source status=${source.status}; expected ${expected.sourceStatus}`)
  if (!source.replaced_by_trade_id) {
    failures.push('source trade is missing replaced_by_trade_id')
    return { source, replacement: null, items: [], failures }
  }
  const [{ data: replacement, error: replacementError }, { data: items, error: itemsError }] = await Promise.all([
    fixture.admin.from('trades')
      .select('id, status, proposer_member_id, recipient_member_id, parent_trade_id, countered_from_trade_id, edited_from_trade_id, version')
      .eq('id', source.replaced_by_trade_id)
      .single(),
    fixture.admin.from('trade_items')
      .select('id, side, player_id, pick_id')
      .eq('trade_id', source.replaced_by_trade_id),
  ])
  if (replacementError) throw new Error(`trade replacement verify: ${replacementError.message}`)
  if (itemsError) throw new Error(`trade replacement item verify: ${itemsError.message}`)
  if (replacement.status !== 'pending') failures.push(`replacement status=${replacement.status}; expected pending`)
  if (replacement.proposer_member_id !== expected.expectedProposerId) failures.push(`replacement proposer=${replacement.proposer_member_id}; expected ${expected.expectedProposerId}`)
  if (replacement.recipient_member_id !== expected.expectedRecipientId) failures.push(`replacement recipient=${replacement.recipient_member_id}; expected ${expected.expectedRecipientId}`)
  if (replacement.parent_trade_id !== expected.initialTradeId) failures.push(`replacement parent=${replacement.parent_trade_id}; expected ${expected.initialTradeId}`)
  if (replacement[expected.sourceColumn] !== sourceTradeId) failures.push(`replacement ${expected.sourceColumn}=${replacement[expected.sourceColumn]}; expected ${sourceTradeId}`)
  if (replacement.version !== expected.expectedVersion) failures.push(`replacement version=${replacement.version}; expected ${expected.expectedVersion}`)
  const playerIds = (items ?? []).flatMap((item) => item.player_id ? [item.player_id] : []).sort()
  const pickIds = (items ?? []).flatMap((item) => item.pick_id ? [item.pick_id] : []).sort()
  const expectedPlayerIds = [...expected.expectedPlayerIds].sort()
  const expectedPickIds = [...expected.expectedPickIds].sort()
  if (JSON.stringify(playerIds) !== JSON.stringify(expectedPlayerIds)) {
    failures.push(`replacement player ids=${playerIds.join(',')}; expected ${expectedPlayerIds.join(',')}`)
  }
  if (JSON.stringify(pickIds) !== JSON.stringify(expectedPickIds)) {
    failures.push(`replacement pick ids=${pickIds.join(',')}; expected ${expectedPickIds.join(',')}`)
  }
  return { source, replacement, items: items ?? [], failures }
}

/** @param {BaseFixture} fixture @param {string} sourceTradeId @param {ReplacementExpectation} expected @param {number} [timeoutMs] */
export const waitForTradeReplacement = async (fixture, sourceTradeId, expected, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeReplacement(fixture, sourceTradeId, expected)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeReplacement(fixture, sourceTradeId, expected)
  }
  return last
}

/** @param {BaseFixture} fixture */
export const verifyPostDeadlineTradeRejected = async (fixture) => {
  const [tradesResult, itemsResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, notes')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('trade_items')
      .select('id, trade_id'),
  ])
  if (tradesResult.error) throw new Error(`post-deadline trade verify: ${tradesResult.error.message}`)
  if (itemsResult.error) throw new Error(`post-deadline trade item verify: ${itemsResult.error.message}`)

  const trades = tradesResult.data ?? []
  const tradeIds = new Set(trades.map((trade) => trade.id))
  const items = (itemsResult.data ?? []).filter((item) => tradeIds.has(item.trade_id))
  const failures = []
  if (trades.length !== 0) failures.push(`post-deadline proposal inserted trades rows=${trades.length}; expected 0`)
  if (items.length !== 0) failures.push(`post-deadline proposal inserted trade_items rows=${items.length}; expected 0`)
  return { trades, items, failures }
}

/** @param {TradeFixture} fixture @param {string} status @param {number} [timeoutMs] */
const waitForTradeStatus = async (fixture, status, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = null
  while (Date.now() - startedAt < timeoutMs) {
    const { data, error } = await fixture.admin
      .from('trades')
      .select('id, status, accepted_at, veto_window_expires_at, completed_at')
      .eq('id', fixture.trade.id)
      .single()
    if (error) throw new Error(`trade status verify: ${error.message}`)
    last = data
    if (data?.status === status) return data
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`trade ${fixture.trade.id} status=${last?.status ?? '<missing>'}; expected ${status}`)
}

/** @param {TradeFixture} fixture */
export const expireAndCompleteAcceptedTrade = async (fixture) => {
  await waitForTradeStatus(fixture, 'accepted')
  const { error: expireError } = await fixture.admin
    .from('trades')
    .update({ veto_window_expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', fixture.trade.id)
  if (expireError) throw new Error(`trade veto-window expiry failed: ${expireError.message}`)

  const { error: completeError } = await fixture.admin.rpc('complete_accepted_trade_atomic', {
    p_trade_id: fixture.trade.id,
  })
  if (completeError) throw new Error(`trade completion failed: ${completeError.message}`)
}

/** @param {FuturePickFixture} fixture */
export const verifyFuturePickTradeProposal = async (fixture) => {
  const { data: trades, error: tradesError } = await fixture.admin
    .from('trades')
    .select('id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, notes')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('proposer_member_id', fixture.proposer.id)
    .eq('recipient_member_id', fixture.recipient.id)
    .eq('status', 'pending')
  if (tradesError) throw new Error(`future-pick trade verify: ${tradesError.message}`)

  const failures = []
  if ((trades ?? []).length !== 1) {
    failures.push(`pending trade rows=${(trades ?? []).length}; expected 1`)
  }
  const trade = trades?.[0] ?? null
  if (!trade) return { trade, items: [], picks: [], failures }

  const { data: items, error: itemsError } = await fixture.admin
    .from('trade_items')
    .select('id, trade_id, side, player_id, pick_id')
    .eq('trade_id', trade.id)
    .order('side', { ascending: true })
  if (itemsError) throw new Error(`future-pick trade item verify: ${itemsError.message}`)

  const { data: picks, error: picksError } = await fixture.admin
    .from('draft_picks')
    .select('id, season_year, round, original_owner_id, current_owner_id')
    .in('id', [fixture.proposerFuturePick.id, fixture.recipientFuturePick.id])
  if (picksError) throw new Error(`future-pick asset verify: ${picksError.message}`)

  const proposerItem = (items ?? []).find((item) => item.side === 'proposer')
  const recipientItem = (items ?? []).find((item) => item.side === 'recipient')
  if ((items ?? []).length !== 2) failures.push(`trade_items rows=${(items ?? []).length}; expected 2`)
  if (proposerItem?.pick_id !== fixture.proposerFuturePick.id) {
    failures.push(`proposer item pick=${proposerItem?.pick_id}; expected ${fixture.proposerFuturePick.id}`)
  }
  if (recipientItem?.pick_id !== fixture.recipientFuturePick.id) {
    failures.push(`recipient item pick=${recipientItem?.pick_id}; expected ${fixture.recipientFuturePick.id}`)
  }
  if ((items ?? []).some((item) => item.player_id != null)) failures.push('future-pick proposal unexpectedly inserted player items')

  const picksById = new Map((picks ?? []).map((pick) => [pick.id, pick]))
  const proposerPick = picksById.get(fixture.proposerFuturePick.id)
  const recipientPick = picksById.get(fixture.recipientFuturePick.id)
  if (proposerPick?.current_owner_id !== fixture.proposer.id) {
    failures.push(`proposer future pick owner=${proposerPick?.current_owner_id ?? '<missing>'}; expected proposer ${fixture.proposer.id}`)
  }
  if (recipientPick?.current_owner_id !== fixture.recipient.id) {
    failures.push(`recipient future pick owner=${recipientPick?.current_owner_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (proposerPick?.season_year !== fixture.targetFuturePickYear || recipientPick?.season_year !== fixture.targetFuturePickYear) {
    failures.push(`future pick years=${proposerPick?.season_year ?? '<missing>'}/${recipientPick?.season_year ?? '<missing>'}; expected ${fixture.targetFuturePickYear}`)
  }

  return { trade, items: items ?? [], picks: picks ?? [], failures }
}

/** @param {FuturePickFixture} fixture @param {number} [timeoutMs] */
export const waitForFuturePickTradeProposal = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyFuturePickTradeProposal(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyFuturePickTradeProposal(fixture)
  }
  return last
}

/** @param {TradeFixture} fixture */
export const verifyTradeAccepted = async (fixture) => {
  const [tradeResult, rosterResult, transactionResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, completed_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id, acquired_via')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('related_trade_id', fixture.trade.id),
  ])
  if (tradeResult.error) throw new Error(`accepted trade verify: ${tradeResult.error.message}`)
  if (rosterResult.error) throw new Error(`accepted roster verify: ${rosterResult.error.message}`)
  if (transactionResult.error) throw new Error(`accepted transactions verify: ${transactionResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const roster = rosterResult.data ?? []
  const transactions = transactionResult.data ?? []
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))

  if (trade.status !== 'completed' || !trade.accepted_at || !trade.completed_at) {
    failures.push(`trade status=${trade.status}, accepted_at=${trade.accepted_at ?? '<null>'}, completed_at=${trade.completed_at ?? '<null>'}; expected completed timestamps`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`proposer player owner=${rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.proposer.id) {
    failures.push(`recipient player owner=${rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id ?? '<missing>'}; expected proposer ${fixture.proposer.id}`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.acquired_via !== 'trade' || rosterByPlayer.get(fixture.recipientPlayer.id)?.acquired_via !== 'trade') {
    failures.push('accepted players did not receive acquired_via=trade')
  }
  if (transactions.length !== 4) {
    failures.push(`roster_transactions count=${transactions.length}; expected 4 trade in/out rows`)
  }

  return { trade, roster, transactions, failures }
}

/** @param {TradeFixture} fixture @param {number} [timeoutMs] */
export const waitForTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeAccepted(fixture)
  }
  return last
}

/** @param {FuturePickTradeFixture} fixture */
export const verifyFuturePickTradeAccepted = async (fixture) => {
  const [tradeResult, picksResult, rosterResult, transactionResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, completed_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('draft_picks')
      .select('id, season_year, round, original_owner_id, current_owner_id, is_used')
      .in('id', [fixture.proposerFuturePick.id, fixture.recipientFuturePick.id]),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id, acquired_via')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('related_trade_id', fixture.trade.id),
  ])
  if (tradeResult.error) throw new Error(`future-pick accepted trade verify: ${tradeResult.error.message}`)
  if (picksResult.error) throw new Error(`future-pick accepted picks verify: ${picksResult.error.message}`)
  if (rosterResult.error) throw new Error(`future-pick accepted roster verify: ${rosterResult.error.message}`)
  if (transactionResult.error) throw new Error(`future-pick accepted transactions verify: ${transactionResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const picks = picksResult.data ?? []
  const roster = rosterResult.data ?? []
  const transactions = transactionResult.data ?? []
  const picksById = new Map(picks.map((pick) => [pick.id, pick]))
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))

  if (trade.status !== 'completed' || !trade.accepted_at || !trade.completed_at) {
    failures.push(`trade status=${trade.status}, accepted_at=${trade.accepted_at ?? '<null>'}, completed_at=${trade.completed_at ?? '<null>'}; expected completed timestamps`)
  }
  if (picksById.get(fixture.proposerFuturePick.id)?.current_owner_id !== fixture.recipient.id) {
    failures.push(`proposer future pick owner=${picksById.get(fixture.proposerFuturePick.id)?.current_owner_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (picksById.get(fixture.recipientFuturePick.id)?.current_owner_id !== fixture.proposer.id) {
    failures.push(`recipient future pick owner=${picksById.get(fixture.recipientFuturePick.id)?.current_owner_id ?? '<missing>'}; expected proposer ${fixture.proposer.id}`)
  }
  if ((picks ?? []).some((pick) => pick.is_used)) failures.push('accepted future-pick trade unexpectedly marked a pick used')
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.proposer.id) {
    failures.push(`proposer player owner=${rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id ?? '<missing>'}; expected unchanged proposer ${fixture.proposer.id}`)
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`recipient player owner=${rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id ?? '<missing>'}; expected unchanged recipient ${fixture.recipient.id}`)
  }
  if (transactions.length !== 0) {
    failures.push(`roster_transactions count=${transactions.length}; expected 0 for pick-only trade`)
  }

  return { trade, picks, roster, transactions, failures }
}

/** @param {FuturePickTradeFixture} fixture @param {number} [timeoutMs] */
export const waitForFuturePickTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyFuturePickTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyFuturePickTradeAccepted(fixture)
  }
  return last
}

/** @param {OverflowTradeFixture} fixture */
export const verifyOverflowTradeAccepted = async (fixture) => {
  const [tradeResult, rosterResult, picksResult, tradeTransactionResult, dropTransactionResult, waiverResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, completed_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id, acquired_via')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('draft_picks')
      .select('id, season_year, round, original_owner_id, current_owner_id, is_used')
      .eq('id', fixture.recipientFuturePick.id)
      .single(),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('related_trade_id', fixture.trade.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('member_id', fixture.recipient.id)
      .eq('player_id', fixture.recipientPlayer.id)
      .eq('transaction_type', 'fa_drop')
      .is('related_trade_id', null),
    fixture.admin
      .from('waiver_wire_log')
      .select('id, league_id, league_season_id, player_id, dropped_by_member_id, clears_at')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('player_id', fixture.recipientPlayer.id)
      .eq('dropped_by_member_id', fixture.recipient.id),
  ])
  if (tradeResult.error) throw new Error(`overflow accepted trade verify: ${tradeResult.error.message}`)
  if (rosterResult.error) throw new Error(`overflow accepted roster verify: ${rosterResult.error.message}`)
  if (picksResult.error) throw new Error(`overflow accepted pick verify: ${picksResult.error.message}`)
  if (tradeTransactionResult.error) throw new Error(`overflow accepted trade transactions verify: ${tradeTransactionResult.error.message}`)
  if (dropTransactionResult.error) throw new Error(`overflow accepted drop transactions verify: ${dropTransactionResult.error.message}`)
  if (waiverResult.error) throw new Error(`overflow accepted waiver log verify: ${waiverResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const roster = rosterResult.data ?? []
  const tradeTransactions = tradeTransactionResult.data ?? []
  const dropTransactions = dropTransactionResult.data ?? []
  const waiverLogs = waiverResult.data ?? []
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))
  const recipientActiveRoster = roster.filter((row) => row.member_id === fixture.recipient.id)

  if (trade.status !== 'completed' || !trade.accepted_at || !trade.completed_at) {
    failures.push(`trade status=${trade.status}, accepted_at=${trade.accepted_at ?? '<null>'}, completed_at=${trade.completed_at ?? '<null>'}; expected completed timestamps`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`incoming player owner=${rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.acquired_via !== 'trade') {
    failures.push(`incoming player acquired_via=${rosterByPlayer.get(fixture.proposerPlayer.id)?.acquired_via ?? '<missing>'}; expected trade`)
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`existing player owner=${rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (recipientActiveRoster.length !== fixture.rosterSize + 1) {
    failures.push(`recipient active roster count=${recipientActiveRoster.length}; expected lazy overflow ${fixture.rosterSize + 1}`)
  }
  if (picksResult.data.current_owner_id !== fixture.proposer.id) {
    failures.push(`recipient future pick owner=${picksResult.data.current_owner_id}; expected proposer ${fixture.proposer.id}`)
  }
  if (picksResult.data.is_used) failures.push('accepted overflow trade unexpectedly marked the pick used')
  if (tradeTransactions.length !== 2) {
    failures.push(`trade roster_transactions count=${tradeTransactions.length}; expected 2 player trade rows`)
  }
  if (dropTransactions.length !== 0) {
    failures.push(`fa_drop transaction count=${dropTransactions.length}; expected no automatic trade drop`)
  }
  if (waiverLogs.length !== 0) {
    failures.push(`waiver_wire_log rows=${waiverLogs.length}; expected no automatic waiver row`)
  }

  return {
    trade,
    roster,
    pick: picksResult.data,
    tradeTransactions,
    dropTransactions,
    waiverLogs,
    failures,
  }
}

/** @param {OverflowTradeFixture} fixture @param {number} [timeoutMs] */
export const waitForOverflowTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyOverflowTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyOverflowTradeAccepted(fixture)
  }
  return last
}

/** @param {TradeFixture} fixture @param {string} expectedStatus */
export const verifyTradeTerminalStatus = async (fixture, expectedStatus) => {
  const [tradeResult, rosterResult, transactionResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, completed_at, veto_window_expires_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id, acquired_via')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('related_trade_id', fixture.trade.id),
  ])
  if (tradeResult.error) throw new Error(`${expectedStatus} trade verify: ${tradeResult.error.message}`)
  if (rosterResult.error) throw new Error(`${expectedStatus} roster verify: ${rosterResult.error.message}`)
  if (transactionResult.error) throw new Error(`${expectedStatus} transactions verify: ${transactionResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const roster = rosterResult.data ?? []
  const transactions = transactionResult.data ?? []
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))

  if (trade.status !== expectedStatus) {
    failures.push(`trade status=${trade.status}; expected ${expectedStatus}`)
  }
  if (trade.accepted_at || trade.completed_at || trade.veto_window_expires_at) {
    failures.push(`terminal ${expectedStatus} trade unexpectedly has accepted/completed/veto timestamps`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.proposer.id) {
    failures.push(`proposer player owner=${rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id ?? '<missing>'}; expected proposer ${fixture.proposer.id}`)
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`recipient player owner=${rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (transactions.length !== 0) {
    failures.push(`roster_transactions count=${transactions.length}; expected 0 for ${expectedStatus}`)
  }

  return { trade, roster, transactions, failures }
}

/** @param {TradeFixture} fixture @param {string} expectedStatus @param {number} [timeoutMs] */
export const waitForTradeTerminalStatus = async (fixture, expectedStatus, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeTerminalStatus(fixture, expectedStatus)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeTerminalStatus(fixture, expectedStatus)
  }
  return last
}

/** @param {VetoTradeFixture} fixture */
export const verifyTradeVetoed = async (fixture) => {
  const [tradeResult, vetoResult, rosterResult, transactionResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, veto_window_expires_at, vetoed_at, completed_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('trade_vetos')
      .select('id, trade_id, member_id, veto_type')
      .eq('trade_id', fixture.trade.id),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, related_trade_id')
      .eq('related_trade_id', fixture.trade.id),
  ])
  if (tradeResult.error) throw new Error(`vetoed trade verify: ${tradeResult.error.message}`)
  if (vetoResult.error) throw new Error(`veto rows verify: ${vetoResult.error.message}`)
  if (rosterResult.error) throw new Error(`veto roster verify: ${rosterResult.error.message}`)
  if (transactionResult.error) throw new Error(`veto transaction verify: ${transactionResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const vetoRows = vetoResult.data ?? []
  const roster = rosterResult.data ?? []
  const transactions = transactionResult.data ?? []
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))
  if (trade.status !== 'vetoed' || !trade.accepted_at || !trade.vetoed_at || trade.completed_at) {
    failures.push(`trade status=${trade.status}, accepted_at=${trade.accepted_at ?? '<null>'}, vetoed_at=${trade.vetoed_at ?? '<null>'}, completed_at=${trade.completed_at ?? '<null>'}; expected vetoed without completion`)
  }
  if (vetoRows.length !== 1 || vetoRows[0]?.member_id !== fixture.observer.id || vetoRows[0]?.veto_type !== 'member') {
    failures.push(`veto rows=${JSON.stringify(vetoRows)}; expected one member veto from observer ${fixture.observer.id}`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.proposer.id) {
    failures.push('proposer player moved despite veto')
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push('recipient player moved despite veto')
  }
  if (transactions.length !== 0) {
    failures.push(`trade transaction rows=${transactions.length}; expected 0 for vetoed trade`)
  }
  return { trade, vetoRows, roster, transactions, failures }
}

/** @param {VetoTradeFixture} fixture @param {number} [timeoutMs] */
export const waitForTradeVetoed = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeVetoed(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeVetoed(fixture)
  }
  return last
}

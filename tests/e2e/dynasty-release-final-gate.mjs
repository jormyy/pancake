import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { requireEnv, resolvedEnv } from './env.mjs'

import {
  ARTIFACT_DIR,
  apiPost,
  assertCondition,
  createSupabaseClient,
  createWaiverLog,
  expectError,
  fetchTrade,
  findClaim,
  getBalance,
  getWeeklyAddCount,
  makeClaimDue,
  pastIso,
  processWaiversUntil,
  record,
  rosterHas,
  rows,
  setupFixture,
  step,
  todayET,
  tomorrowIso,
  writeReport,
} from './dynasty-release-final-support.mjs'

async function main() {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey', 'apiBaseUrl'])
  const admin = createSupabaseClient(env.supabaseUrl, env.serviceRoleKey)
  const context = { supabaseUrl: env.supabaseUrl, apiBaseUrl: env.apiBaseUrl }
  await mkdir(ARTIFACT_DIR, { recursive: true })
  let fixture

  try {
    const health = await fetch(`${env.apiBaseUrl}/health`).then((res) => res.json())
    assertCondition(health?.ok === true, 'Edge API health check did not return ok=true')
    record('environment', 'edge api health', 'PASS', 'GET /health returned ok=true')

    try {
      fixture = await setupFixture(env, admin)
      context.runId = fixture.runId
      context.leagueId = fixture.league.id
      record('fixtures', 'isolated league, users, seeded players', 'PASS',
        `league=${fixture.league.id}; users=${fixture.users.length}; players=${fixture.players.length}`)
    } catch (error) {
      record('fixtures', 'isolated league, users, seeded players', 'FAIL',
        error instanceof Error ? error.message : String(error))
      throw error
    }

    const [commissioner, managerTwo, managerThree, managerFour] = fixture.members
    const [
      freeAddPlayer,
      blockedFreeAddPlayer,
      managerTwoRosterPlayer,
      dropAddTargetPlayer,
      waiverLimitPlayer,
      cancelClaimPlayer,
      editClaimPlayer,
      highBidPlayer,
      tieBidPlayer,
      expiredTradePlayer,
      reservedEditClaimPlayer,
      zeroBidPlayer,
      multiTradePlayerA,
      multiTradePlayerB,
      multiTradePlayerC,
    ] = fixture.players

    await step('commissioner settings', 'weekly add limit, FAAB mode, budget, and state RPC', async () => {
      const { data: leagueRow, error: leagueError } = await admin
        .from('leagues')
        .select('weekly_add_limit, waiver_mode, faab_starting_budget, roster_size')
        .eq('id', fixture.league.id)
        .single()
      if (leagueError) throw new Error(`league settings lookup: ${leagueError.message}`)
      assertCondition(leagueRow.weekly_add_limit === 1, `weekly_add_limit=${leagueRow.weekly_add_limit}`)
      assertCondition(leagueRow.waiver_mode === 'faab', `waiver_mode=${leagueRow.waiver_mode}`)
      assertCondition(leagueRow.faab_starting_budget === 100, `faab_starting_budget=${leagueRow.faab_starting_budget}`)
      const { data: state, error: stateError } = await commissioner.session.client.rpc('get_member_transaction_state', {
        p_member_id: commissioner.id,
        p_league_id: fixture.league.id,
      })
      if (stateError) throw new Error(`get_member_transaction_state: ${stateError.message}`)
      const row = state?.[0]
      assertCondition(row?.weekly_add_limit === 1, `state weekly_add_limit=${row?.weekly_add_limit}`)
      assertCondition(row?.faab_balance === 100, `state faab_balance=${row?.faab_balance}`)
      return 'commissioner-authenticated settings and transaction state reflect weekly_add_limit=1, waiver_mode=faab, FAAB=$100'
    })

    await step('weekly add limits', 'free-agent add consumes count and second add is blocked', async () => {
      const { error: addError } = await commissioner.session.client.rpc('add_free_agent_atomic', {
        p_member_id: commissioner.id,
        p_league_id: fixture.league.id,
        p_player_id: freeAddPlayer.id,
      })
      if (addError) throw new Error(`first add_free_agent_atomic: ${addError.message}`)
      const message = await expectError(
        'second add_free_agent_atomic',
        () => commissioner.session.client.rpc('add_free_agent_atomic', {
          p_member_id: commissioner.id,
          p_league_id: fixture.league.id,
          p_player_id: blockedFreeAddPlayer.id,
        }).then((result) => {
          if (result.error) throw new Error(result.error.message)
        }),
        'Weekly add limit reached',
      )
      const count = await getWeeklyAddCount(admin, fixture.league.id, fixture.season.id, commissioner.id)
      const blockedRosterId = await rosterHas(admin, fixture.league.id, fixture.season.id, commissioner.id, blockedFreeAddPlayer.id)
      assertCondition(count === 1, `weekly add count=${count}; expected 1`)
      assertCondition(blockedRosterId === null, 'blocked player was rostered')
      return `first add succeeded, second add failed with "${message}", count=${count}`
    })

    await step('weekly add limits', 'waiver processing and drop-add enforce the limit', async () => {
      const { data: rosterSeed, error: rosterSeedError } = await admin
        .from('roster_players')
        .insert({
          member_id: managerTwo.id,
          league_id: fixture.league.id,
          league_season_id: fixture.season.id,
          player_id: managerTwoRosterPlayer.id,
          acquired_via: 'e2e_release_gate',
        })
        .select('id')
        .single()
      if (rosterSeedError) throw new Error(`manager two roster seed: ${rosterSeedError.message}`)

      const waiverLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, waiverLimitPlayer.id)
      await apiPost(env, managerTwo.session.token, '/waivers/claims', {
        memberId: managerTwo.id,
        leagueId: fixture.league.id,
        playerId: waiverLimitPlayer.id,
        bidAmount: 4,
      })
      const claim = await findClaim(admin, managerTwo.id, waiverLimitPlayer.id)

      const { data: overrideCount, error: overrideError } = await commissioner.session.client.rpc('commissioner_override_weekly_add_count_atomic', {
        p_league_id: fixture.league.id,
        p_member_id: managerTwo.id,
        p_add_count: 1,
      })
      if (overrideError) throw new Error(`commissioner_override_weekly_add_count_atomic: ${overrideError.message}`)
      assertCondition(Number(overrideCount) === 1, `override returned ${overrideCount}`)

      await makeClaimDue(admin, claim.id, waiverLogId)
      await processWaiversUntil(admin, [claim.id])
      const processedClaim = await findClaim(admin, managerTwo.id, waiverLimitPlayer.id)
      assertCondition(processedClaim.status === 'failed_roster', `claim status=${processedClaim.status}`)
      assertCondition(
        String(processedClaim.failure_reason ?? '').includes('Weekly add limit reached'),
        `claim failure_reason=${processedClaim.failure_reason}`,
      )

      const dropAddMessage = await expectError(
        'drop_and_add_free_agent_atomic',
        () => managerTwo.session.client.rpc('drop_and_add_free_agent_atomic', {
          p_roster_player_id: rosterSeed.id,
          p_member_id: managerTwo.id,
          p_league_id: fixture.league.id,
          p_player_id: dropAddTargetPlayer.id,
        }).then((result) => {
          if (result.error) throw new Error(result.error.message)
        }),
        'Weekly add limit reached',
      )
      const stillHasDropPlayer = await rosterHas(admin, fixture.league.id, fixture.season.id, managerTwo.id, managerTwoRosterPlayer.id)
      const hasAddTarget = await rosterHas(admin, fixture.league.id, fixture.season.id, managerTwo.id, dropAddTargetPlayer.id)
      assertCondition(stillHasDropPlayer !== null, 'drop-add removed the original roster player despite failure')
      assertCondition(hasAddTarget === null, 'drop-add added the target despite failure')
      return `waiver claim failed at processing; drop-add failed with "${dropAddMessage}"`
    })

    await step('waiver claims', 'pending claim submit, edit, reorder, and cancel', async () => {
      const logA = await createWaiverLog(admin, fixture.league.id, fixture.season.id, cancelClaimPlayer.id)
      const logB = await createWaiverLog(admin, fixture.league.id, fixture.season.id, editClaimPlayer.id)
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: cancelClaimPlayer.id,
        bidAmount: 5,
        claimOrder: 1,
      })
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: editClaimPlayer.id,
        bidAmount: 5,
        claimOrder: 2,
      })
      const cancelClaim = await findClaim(admin, managerFour.id, cancelClaimPlayer.id)
      const editClaim = await findClaim(admin, managerFour.id, editClaimPlayer.id)
      const reorderResult = await apiPost(env, managerFour.session.token, `/waivers/claims/${editClaim.id}/reorder`, {
        memberId: managerFour.id,
        direction: 'up',
      })
      assertCondition(Number(reorderResult.claimOrder) === 1, `reorder claimOrder=${reorderResult.claimOrder}`)
      await apiPost(env, managerFour.session.token, `/waivers/claims/${editClaim.id}/edit`, {
        memberId: managerFour.id,
        bidAmount: 7,
        claimOrder: 1,
      })
      await apiPost(env, managerFour.session.token, `/waivers/claims/${cancelClaim.id}/cancel`, {
        memberId: managerFour.id,
      })

      const edited = await findClaim(admin, managerFour.id, editClaimPlayer.id)
      const canceled = await findClaim(admin, managerFour.id, cancelClaimPlayer.id)
      assertCondition(edited.status === 'pending', `edited status=${edited.status}`)
      assertCondition(edited.bid_amount === 7, `edited bid=${edited.bid_amount}`)
      assertCondition(edited.claim_order === 1, `edited claim_order=${edited.claim_order}`)
      assertCondition(canceled.status === 'cancelled', `canceled status=${canceled.status}`)

      await writeFile(path.join(ARTIFACT_DIR, 'pending-claims.json'), `${JSON.stringify({ logA, logB, edited, canceled }, null, 2)}\n`)
      return `edited claim ${editClaim.id} to bid=$7/order=1 and canceled claim ${cancelClaim.id}`
    })

    await step('faab waivers', 'blind bids, budget checks, processing, and bid tiebreaker', async () => {
      const { error: limitError } = await commissioner.session.client.rpc('update_league_settings_atomic', {
        p_league_id: fixture.league.id,
        p_settings: { weekly_add_limit: 3 },
      })
      if (limitError) throw new Error(`weekly limit raise: ${limitError.message}`)

      const highBidLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, highBidPlayer.id)
      await apiPost(env, managerThree.session.token, '/waivers/claims', {
        memberId: managerThree.id,
        leagueId: fixture.league.id,
        playerId: highBidPlayer.id,
        bidAmount: 30,
      })
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: highBidPlayer.id,
        bidAmount: 20,
      })
      const highBidWinner = await findClaim(admin, managerThree.id, highBidPlayer.id)
      const highBidLoser = await findClaim(admin, managerFour.id, highBidPlayer.id)
      await makeClaimDue(admin, highBidWinner.id, highBidLogId)
      const { error: highBidLoserDueError } = await admin
        .from('waiver_claims')
        .update({ process_date: todayET() })
        .eq('id', highBidLoser.id)
      if (highBidLoserDueError) throw new Error(`high-bid loser due update: ${highBidLoserDueError.message}`)
      await processWaiversUntil(admin, [highBidWinner.id, highBidLoser.id])

      const tieLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, tieBidPlayer.id)
      await apiPost(env, managerThree.session.token, '/waivers/claims', {
        memberId: managerThree.id,
        leagueId: fixture.league.id,
        playerId: tieBidPlayer.id,
        bidAmount: 11,
      })
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: tieBidPlayer.id,
        bidAmount: 11,
      })
      const tieLoser = await findClaim(admin, managerThree.id, tieBidPlayer.id)
      const tieWinner = await findClaim(admin, managerFour.id, tieBidPlayer.id)
      await makeClaimDue(admin, tieWinner.id, tieLogId)
      const { error: tieLoserDueError } = await admin
        .from('waiver_claims')
        .update({ process_date: todayET() })
        .eq('id', tieLoser.id)
      if (tieLoserDueError) throw new Error(`tie loser due update: ${tieLoserDueError.message}`)
      await processWaiversUntil(admin, [tieWinner.id, tieLoser.id])

      const zeroBidLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, zeroBidPlayer.id)
      await apiPost(env, managerThree.session.token, '/waivers/claims', {
        memberId: managerThree.id,
        leagueId: fixture.league.id,
        playerId: zeroBidPlayer.id,
        bidAmount: 0,
      })
      const zeroBidClaim = await findClaim(admin, managerThree.id, zeroBidPlayer.id)
      assertCondition(zeroBidClaim.bid_amount === 0, `zero bid claim stored bid=${zeroBidClaim.bid_amount}`)
      await makeClaimDue(admin, zeroBidClaim.id, zeroBidLogId)
      await processWaiversUntil(admin, [zeroBidClaim.id])

      const highWinnerRow = await findClaim(admin, managerThree.id, highBidPlayer.id)
      const highLoserRow = await findClaim(admin, managerFour.id, highBidPlayer.id)
      const tieWinnerRow = await findClaim(admin, managerFour.id, tieBidPlayer.id)
      const tieLoserRow = await findClaim(admin, managerThree.id, tieBidPlayer.id)
      const zeroBidRow = await findClaim(admin, managerThree.id, zeroBidPlayer.id)
      assertCondition(highWinnerRow.status === 'succeeded', `high bid winner status=${highWinnerRow.status}`)
      assertCondition(highLoserRow.status === 'failed_priority', `high bid loser status=${highLoserRow.status}`)
      assertCondition(tieWinnerRow.status === 'succeeded', `tie winner status=${tieWinnerRow.status}`)
      assertCondition(tieLoserRow.status === 'failed_priority', `tie loser status=${tieLoserRow.status}`)
      assertCondition(zeroBidRow.status === 'succeeded', `zero bid status=${zeroBidRow.status}`)
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerThree.id, highBidPlayer.id), 'high bid winner did not roster player')
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerFour.id, tieBidPlayer.id), 'tie winner did not roster player')
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerThree.id, zeroBidPlayer.id), 'zero bid winner did not roster player')
      const { data: zeroBidActivity, error: zeroBidActivityError } = await admin
        .from('league_activity')
        .select('id, event_type, body, metadata')
        .eq('related_claim_id', zeroBidClaim.id)
        .eq('event_type', 'faab_bid_won')
        .maybeSingle()
      if (zeroBidActivityError) throw new Error(`zero bid activity lookup: ${zeroBidActivityError.message}`)
      assertCondition(Boolean(zeroBidActivity), 'zero bid win did not write FAAB history')
      assertCondition(Number(zeroBidActivity?.metadata?.bid_amount ?? -1) === 0, `zero bid activity metadata=${JSON.stringify(zeroBidActivity?.metadata)}`)
      assertCondition(String(zeroBidActivity?.body ?? '').includes('$0'), `zero bid activity body=${zeroBidActivity?.body}`)
      const managerThreeBalance = await getBalance(admin, fixture.league.id, fixture.season.id, managerThree.id)
      const managerFourBalance = await getBalance(admin, fixture.league.id, fixture.season.id, managerFour.id)
      assertCondition(managerThreeBalance === 70, `managerThree FAAB=${managerThreeBalance}; expected 70`)
      assertCondition(managerFourBalance === 89, `managerFour FAAB=${managerFourBalance}; expected 89`)
      return 'bid $30 beat $20; equal $11 bids used waiver-priority tiebreaker; $0 bid processed with history; balances are $70 and $89'
    })

    await step('commissioner controls', 'FAAB balance adjustment and weekly count override', async () => {
      const { data: adjusted, error: adjustError } = await commissioner.session.client.rpc('commissioner_adjust_faab_balance_atomic', {
        p_league_id: fixture.league.id,
        p_member_id: managerTwo.id,
        p_balance: 42,
      })
      if (adjustError) throw new Error(`commissioner_adjust_faab_balance_atomic: ${adjustError.message}`)
      assertCondition(Number(adjusted) === 42, `adjusted balance=${adjusted}`)
      const { data: state, error: stateError } = await managerTwo.session.client.rpc('get_member_transaction_state', {
        p_member_id: managerTwo.id,
        p_league_id: fixture.league.id,
      })
      if (stateError) throw new Error(`manager two transaction state: ${stateError.message}`)
      assertCondition(state?.[0]?.faab_balance === 42, `state FAAB=${state?.[0]?.faab_balance}`)
      assertCondition(state?.[0]?.weekly_add_count === 1, `state weekly_add_count=${state?.[0]?.weekly_add_count}`)
      return 'commissioner set Manager Two FAAB to $42 and weekly_add_count remains overridden at 1'
    })

    await step('trade negotiation', 'counteroffers, outgoing edits, and expired edit rejection', async () => {
      const proposed = await apiPost(env, commissioner.session.token, '/trades/propose', {
        memberId: commissioner.id,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.season.id,
        recipientMemberId: managerTwo.id,
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 5,
        requestFaabAmount: 1,
        notes: 'release gate original',
      })
      const countered = await apiPost(env, managerTwo.session.token, `/trades/${proposed.tradeId}/counter`, {
        memberId: managerTwo.id,
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 2,
        requestFaabAmount: 4,
        notes: 'release gate counter',
      })
      const edited = await apiPost(env, managerTwo.session.token, `/trades/${countered.tradeId}/edit`, {
        memberId: managerTwo.id,
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 3,
        requestFaabAmount: 4,
        notes: 'release gate edited counter',
      })

      const original = await fetchTrade(admin, proposed.tradeId)
      const counter = await fetchTrade(admin, countered.tradeId)
      const edit = await fetchTrade(admin, edited.tradeId)
      assertCondition(original.status === 'countered', `original status=${original.status}`)
      assertCondition(counter.status === 'edited', `counter status=${counter.status}`)
      assertCondition(edit.status === 'pending', `edit status=${edit.status}`)
      assertCondition(counter.countered_from_trade_id === original.id, 'counter missing countered_from_trade_id')
      assertCondition(edit.edited_from_trade_id === counter.id, 'edit missing edited_from_trade_id')
      assertCondition(edit.version === 3, `edited version=${edit.version}`)
      assertCondition(edit.proposer_faab_amount === 3 && edit.recipient_faab_amount === 4, `edited FAAB=${edit.proposer_faab_amount}/${edit.recipient_faab_amount}`)

      const expiring = await apiPost(env, commissioner.session.token, '/trades/propose', {
        memberId: commissioner.id,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.season.id,
        recipientMemberId: managerTwo.id,
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 1,
        requestFaabAmount: 1,
        expiresAt: tomorrowIso(),
        notes: 'release gate expired edit',
      })
      const { error: expireUpdateError } = await admin
        .from('trades')
        .update({ expires_at: pastIso() })
        .eq('id', expiring.tradeId)
      if (expireUpdateError) throw new Error(`expire trade update: ${expireUpdateError.message}`)
      const expiredMessage = await expectError(
        'expired trade edit',
        () => apiPost(env, commissioner.session.token, `/trades/${expiring.tradeId}/edit`, {
          memberId: commissioner.id,
          offerPlayerIds: [],
          requestPlayerIds: [],
          offerPickIds: [],
          requestPickIds: [],
          offerFaabAmount: 2,
          requestFaabAmount: 1,
        }),
        'expired',
      )
      const expired = await fetchTrade(admin, expiring.tradeId)
      assertCondition(expired.status === 'expired', `expired trade status=${expired.status}`)

      const { error: expiredRosterSeedError } = await admin
        .from('roster_players')
        .insert({
          member_id: commissioner.id,
          league_id: fixture.league.id,
          league_season_id: fixture.season.id,
          player_id: expiredTradePlayer.id,
          acquired_via: 'e2e_release_gate',
        })
      if (expiredRosterSeedError) throw new Error(`expired trade roster seed: ${expiredRosterSeedError.message}`)
      return `counter/edit chain reached version 3; expired edit rejected with "${expiredMessage}"`
    })

    await step('trade block and faab trading', 'Make Offer path creates and completes FAAB trade from a block item', async () => {
      const block = await apiPost(env, managerFour.session.token, '/trades/block', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: tieBidPlayer.id,
        note: 'release gate available for offers',
      })
      const { data: blockRow, error: blockError } = await admin
        .from('trade_block_items')
        .select('id, member_id, player_id, note')
        .eq('id', block.tradeBlockItemId)
        .single()
      if (blockError) throw new Error(`trade block lookup: ${blockError.message}`)
      assertCondition(blockRow.player_id === tieBidPlayer.id, `block player=${blockRow.player_id}`)

      const makeOffer = await apiPost(env, managerThree.session.token, '/trades/propose', {
        memberId: managerThree.id,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.season.id,
        recipientMemberId: managerFour.id,
        offerPlayerIds: [highBidPlayer.id],
        requestPlayerIds: [tieBidPlayer.id],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 10,
        requestFaabAmount: 0,
        notes: 'release gate make offer from trade block',
      })
      await apiPost(env, managerFour.session.token, `/trades/${makeOffer.tradeId}/accept`, {
        memberId: managerFour.id,
        dropRosterPlayerIds: [],
      })

      const reservedEditLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, reservedEditClaimPlayer.id)
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: reservedEditClaimPlayer.id,
        bidAmount: 1,
        claimOrder: 3,
      })
      const reservedEditClaim = await findClaim(admin, managerFour.id, reservedEditClaimPlayer.id)
      const reservedEditMessage = await expectError(
        'reserved trade drop edit_waiver_claim_atomic',
        () => apiPost(env, managerFour.session.token, `/waivers/claims/${reservedEditClaim.id}/edit`, {
          memberId: managerFour.id,
          dropPlayerId: tieBidPlayer.id,
          bidAmount: 1,
          claimOrder: reservedEditClaim.claim_order,
        }),
        'reserved',
      )

      const { error: windowError } = await admin
        .from('trades')
        .update({ veto_window_expires_at: pastIso() })
        .eq('id', makeOffer.tradeId)
      if (windowError) throw new Error(`veto window update: ${windowError.message}`)
      const { error: processError } = await admin.rpc('process_due_accepted_trades_atomic', { p_limit: 20 })
      if (processError) throw new Error(`process_due_accepted_trades_atomic: ${processError.message}`)

      const completed = await fetchTrade(admin, makeOffer.tradeId)
      assertCondition(completed.status === 'completed', `trade status=${completed.status}`)
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerFour.id, highBidPlayer.id), 'offered player did not move to trade-block owner')
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerThree.id, tieBidPlayer.id), 'requested trade-block player did not move to offer maker')
      const { data: blockAfterTrade, error: blockAfterTradeError } = await admin
        .from('trade_block_items')
        .select('id')
        .eq('id', block.tradeBlockItemId)
        .maybeSingle()
      if (blockAfterTradeError) throw new Error(`trade block post-completion lookup: ${blockAfterTradeError.message}`)
      assertCondition(blockAfterTrade === null, 'trade block player listing survived completed trade')
      const managerThreeBalance = await getBalance(admin, fixture.league.id, fixture.season.id, managerThree.id)
      const managerFourBalance = await getBalance(admin, fixture.league.id, fixture.season.id, managerFour.id)
      assertCondition(managerThreeBalance === 60, `managerThree balance after trade=${managerThreeBalance}; expected 60`)
      assertCondition(managerFourBalance === 99, `managerFour balance after trade=${managerFourBalance}; expected 99`)
      return `block item ${block.tradeBlockItemId} produced trade ${makeOffer.tradeId}; reserved drop edit rejected with "${reservedEditMessage}"; claim log ${reservedEditLogId}`
    })

    await step('multi-team trades', 'three-team routed player, pick, and FAAB trade completes atomically', async () => {
      const { error: rosterSeedError } = await admin
        .from('roster_players')
        .insert([
          {
            member_id: commissioner.id,
            league_id: fixture.league.id,
            league_season_id: fixture.season.id,
            player_id: multiTradePlayerA.id,
            acquired_via: 'e2e_release_gate',
          },
          {
            member_id: managerTwo.id,
            league_id: fixture.league.id,
            league_season_id: fixture.season.id,
            player_id: multiTradePlayerB.id,
            acquired_via: 'e2e_release_gate',
          },
          {
            member_id: managerThree.id,
            league_id: fixture.league.id,
            league_season_id: fixture.season.id,
            player_id: multiTradePlayerC.id,
            acquired_via: 'e2e_release_gate',
          },
        ])
      if (rosterSeedError) throw new Error(`multi-team roster seed: ${rosterSeedError.message}`)

      const { data: managerTwoPick, error: pickError } = await admin
        .from('draft_picks')
        .select('id, current_owner_id')
        .eq('league_id', fixture.league.id)
        .eq('current_owner_id', managerTwo.id)
        .eq('is_used', false)
        .order('season_year', { ascending: true })
        .order('round', { ascending: true })
        .limit(1)
        .single()
      if (pickError) throw new Error(`multi-team pick lookup: ${pickError.message}`)

      const beforeCommissionerFaab = await getBalance(admin, fixture.league.id, fixture.season.id, commissioner.id)
      const beforeManagerTwoFaab = await getBalance(admin, fixture.league.id, fixture.season.id, managerTwo.id)
      const beforeManagerThreeFaab = await getBalance(admin, fixture.league.id, fixture.season.id, managerThree.id)
      const proposed = await apiPost(env, commissioner.session.token, '/trades/propose-multi', {
        memberId: commissioner.id,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.season.id,
        participantMemberIds: [commissioner.id, managerTwo.id, managerThree.id],
        items: [
          { fromMemberId: commissioner.id, toMemberId: managerTwo.id, playerId: multiTradePlayerA.id },
          { fromMemberId: commissioner.id, toMemberId: managerTwo.id, faabAmount: 2 },
          { fromMemberId: managerTwo.id, toMemberId: managerThree.id, playerId: multiTradePlayerB.id },
          { fromMemberId: managerTwo.id, toMemberId: managerThree.id, pickId: managerTwoPick.id },
          { fromMemberId: managerThree.id, toMemberId: commissioner.id, playerId: multiTradePlayerC.id },
          { fromMemberId: managerThree.id, toMemberId: commissioner.id, faabAmount: 4 },
        ],
        notes: 'release gate three-team trade',
      })

      await apiPost(env, managerTwo.session.token, `/trades/${proposed.tradeId}/accept`, {
        memberId: managerTwo.id,
        dropRosterPlayerIds: [],
      })
      const midTrade = await fetchTrade(admin, proposed.tradeId)
      assertCondition(midTrade.status === 'pending', `multi-team mid status=${midTrade.status}`)

      await apiPost(env, managerThree.session.token, `/trades/${proposed.tradeId}/accept`, {
        memberId: managerThree.id,
        dropRosterPlayerIds: [],
      })
      const acceptedTrade = await fetchTrade(admin, proposed.tradeId)
      assertCondition(acceptedTrade.status === 'accepted', `multi-team accepted status=${acceptedTrade.status}`)

      const { data: participants, error: participantError } = await admin
        .from('trade_participants')
        .select('member_id, accepted_at')
        .eq('trade_id', proposed.tradeId)
      if (participantError) throw new Error(`multi-team participants lookup: ${participantError.message}`)
      assertCondition((participants ?? []).length === 3, `participant rows=${(participants ?? []).length}; expected 3`)
      assertCondition((participants ?? []).every((row) => row.accepted_at), 'not every participant accepted')

      const { error: windowError } = await admin
        .from('trades')
        .update({ veto_window_expires_at: pastIso() })
        .eq('id', proposed.tradeId)
      if (windowError) throw new Error(`multi-team veto window update: ${windowError.message}`)
      const { error: processError } = await admin.rpc('process_due_accepted_trades_atomic', { p_limit: 20 })
      if (processError) throw new Error(`multi-team process_due_accepted_trades_atomic: ${processError.message}`)

      const completedTrade = await fetchTrade(admin, proposed.tradeId)
      const { data: movedPick, error: movedPickError } = await admin
        .from('draft_picks')
        .select('current_owner_id')
        .eq('id', managerTwoPick.id)
        .single()
      if (movedPickError) throw new Error(`multi-team moved pick lookup: ${movedPickError.message}`)

      assertCondition(completedTrade.status === 'completed', `multi-team completed status=${completedTrade.status}`)
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerTwo.id, multiTradePlayerA.id), 'commissioner player did not move to manager two')
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerThree.id, multiTradePlayerB.id), 'manager two player did not move to manager three')
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, commissioner.id, multiTradePlayerC.id), 'manager three player did not move to commissioner')
      assertCondition(movedPick.current_owner_id === managerThree.id, `multi-team pick owner=${movedPick.current_owner_id}`)
      assertCondition(await getBalance(admin, fixture.league.id, fixture.season.id, commissioner.id) === beforeCommissionerFaab + 2, 'commissioner FAAB net did not match')
      assertCondition(await getBalance(admin, fixture.league.id, fixture.season.id, managerTwo.id) === beforeManagerTwoFaab + 2, 'manager two FAAB net did not match')
      assertCondition(await getBalance(admin, fixture.league.id, fixture.season.id, managerThree.id) === beforeManagerThreeFaab - 4, 'manager three FAAB net did not match')
      return `completed trade ${proposed.tradeId} with 3 participants, routed players, one pick, and net FAAB movement`
    })

    await step('notification preferences', 'authenticated user can persist own preference toggles only', async () => {
      const { error: upsertError } = await managerThree.session.client
        .from('notification_preferences')
        .upsert({
          user_id: managerThree.user.id,
          trade_enabled: false,
          waiver_enabled: true,
          draft_enabled: false,
          activity_enabled: true,
        }, { onConflict: 'user_id' })
      if (upsertError) throw new Error(`notification preference upsert: ${upsertError.message}`)

      const { data, error: selectError } = await managerThree.session.client
        .from('notification_preferences')
        .select('trade_enabled, waiver_enabled, draft_enabled, activity_enabled')
        .eq('user_id', managerThree.user.id)
        .single()
      if (selectError) throw new Error(`notification preference select: ${selectError.message}`)
      assertCondition(data.trade_enabled === false, `trade_enabled=${data.trade_enabled}`)
      assertCondition(data.waiver_enabled === true, `waiver_enabled=${data.waiver_enabled}`)
      assertCondition(data.draft_enabled === false, `draft_enabled=${data.draft_enabled}`)
      assertCondition(data.activity_enabled === true, `activity_enabled=${data.activity_enabled}`)

      const { data: crossUserRows, error: crossUserError } = await managerTwo.session.client
        .from('notification_preferences')
        .update({ trade_enabled: true })
        .eq('user_id', managerThree.user.id)
        .select('user_id')
      if (crossUserError) throw new Error(`cross-user notification preference update: ${crossUserError.message}`)
      assertCondition((crossUserRows ?? []).length === 0, 'cross-user notification preference update returned rows')
      const { data: afterCrossUser, error: afterCrossUserError } = await admin
        .from('notification_preferences')
        .select('trade_enabled')
        .eq('user_id', managerThree.user.id)
        .single()
      if (afterCrossUserError) throw new Error(`cross-user notification preference verify: ${afterCrossUserError.message}`)
      assertCondition(afterCrossUser.trade_enabled === false, `cross-user update changed trade_enabled=${afterCrossUser.trade_enabled}`)
      return 'own toggles persisted; cross-user update was filtered by RLS and left values unchanged'
    })

    await step('activity feed', 'release actions emit league activity rows', async () => {
      const { data, error } = await admin
        .from('league_activity')
        .select('event_type')
        .eq('league_id', fixture.league.id)
      if (error) throw new Error(`league activity lookup: ${error.message}`)
      const events = new Set((data ?? []).map((row) => row.event_type))
      const required = [
        'free_agent_added',
        'waiver_claim_failed_add_limit',
        'faab_bid_won',
        'faab_bid_lost',
        'commissioner_faab_adjusted',
        'trade_offered',
        'trade_countered',
        'trade_edited',
        'trade_block_updated',
        'trade_completed',
      ]
      const missing = required.filter((event) => !events.has(event))
      assertCondition(missing.length === 0, `missing activity events: ${missing.join(', ')}`)
      return `observed activity events: ${required.join(', ')}`
    })

    await step('activity feed', 'authenticated feed RPC returns normalized paginated rows', async () => {
      const { data, error } = await commissioner.session.client.rpc('get_league_activity_feed', {
        p_league_id: fixture.league.id,
        p_limit: 50,
        p_offset: 0,
      })
      if (error) throw new Error(`get_league_activity_feed: ${error.message}`)
      const feed = data ?? []
      assertCondition(feed.length > 0, 'feed RPC returned no rows')

      const faabAdjust = feed.find((row) => row.transaction_type === 'commissioner_faab_adjusted')
      assertCondition(faabAdjust?.target_member_id === managerTwo.id, `faab adjust target=${faabAdjust?.target_member_id}`)
      assertCondition(typeof faabAdjust?.target_team_name === 'string' && faabAdjust.target_team_name.length > 0, 'faab adjust missing target team name')

      const freeAgentAdd = feed.find((row) => row.transaction_type === 'fa_add' && row.player_id === freeAddPlayer.id)
      assertCondition(freeAgentAdd?.member_id === commissioner.id, `free-agent feed member=${freeAgentAdd?.member_id}`)
      assertCondition(freeAgentAdd?.is_system === false, `free-agent feed is_system=${freeAgentAdd?.is_system}`)

      return `feed rows=${feed.length}; target=${faabAdjust.target_team_name}; roster transaction=${freeAgentAdd.player_name}`
    })

    await step('db security', 'service-only RPCs and direct table writes are not bypassable by authenticated clients', async () => {
      const directRpcMessage = await expectError(
        'authenticated direct create_waiver_claim_atomic',
        () => managerThree.session.client.rpc('create_waiver_claim_atomic', {
          p_league_id: fixture.league.id,
          p_member_id: managerThree.id,
          p_player_id: blockedFreeAddPlayer.id,
          p_user_id: managerThree.user.id,
          p_bid_amount: 1,
        }).then((result) => {
          if (result.error) throw new Error(result.error.message)
        }),
        'permission denied',
      )
      const { error: directWriteError } = await managerThree.session.client
        .from('faab_balances')
        .insert({
          league_id: fixture.league.id,
          league_season_id: fixture.season.id,
          member_id: managerThree.id,
          balance: 999,
        })
      assertCondition(directWriteError !== null, 'authenticated direct faab_balances insert unexpectedly succeeded')
      return `direct waiver RPC denied with "${directRpcMessage}"; direct FAAB balance insert denied`
    })

    await writeReport(context)
    const failed = rows.filter((row) => row.status !== 'PASS')
    if (failed.length > 0) process.exitCode = 1
  } catch (error) {
    await writeReport(context)
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  } finally {
    await fixture?.dispose()
  }
}

await main()

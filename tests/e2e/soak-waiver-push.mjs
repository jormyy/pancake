import {
  ARTIFACT_ROOT,
  createDisposableLeagueFromSeedUsers,
  fetchAll,
  fetchSingle,
  mkdir,
  path,
  sortedLeagueMembers,
  writeFile,
} from './soak-support.mjs'
import {
  backendJson,
  backendUrl,
  findAvailablePlayer,
  findAvailablePlayers,
  postJson,
  todayET,
} from './soak-backend-support.mjs'
import {
  createRookieDraftFixture,
} from './soak-draft-playoff.mjs'
import {
  createScenarioResourceOwner,
  throwWithCleanup,
} from './scenario-resource-owner.mjs'

export const assertWaiverProcessingScenario = async ({ supabase, env, state, season, resourceOwner }) => {
  const label = 'D.SEA.2 waiver processing'
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 4,
    resourceOwner,
    seasonYear: 4300 + season,
  })
  const [priorityOne, priorityTwo, priorityThree, priorityFour] = fixture.members
  const [sharedPlayer, dropClaimPlayer, fullRosterPlayer, dropPlayer, fillerPlayer] = await findAvailablePlayers(
    supabase,
    fixture.league.id,
    fixture.leagueSeason.id,
    5,
    label,
  )
  const now = new Date()
  const placedOnWaiversAt = new Date(now.getTime() - 49 * 60 * 60 * 1000).toISOString()
  const clearsAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  const processDate = todayET()

  const failures = []
  const priorityRows = fixture.members.map((member, index) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: member.id,
    priority: index + 1,
  }))
  const [{ error: leagueError }, { error: deletePriorityError }, { error: rosterError }, { error: waiverLogError }] = await Promise.all([
    supabase
      .from('leagues')
      .update({ roster_size: 1 })
      .eq('id', fixture.league.id),
    supabase
      .from('waiver_priorities')
      .delete()
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.leagueSeason.id),
    supabase
      .from('roster_players')
      .insert([
        {
          league_id: fixture.league.id,
          league_season_id: fixture.leagueSeason.id,
          member_id: priorityThree.id,
          player_id: dropPlayer.id,
          acquired_via: 'e2e_waiver_processing_fixture',
        },
        {
          league_id: fixture.league.id,
          league_season_id: fixture.leagueSeason.id,
          member_id: priorityFour.id,
          player_id: fillerPlayer.id,
          acquired_via: 'e2e_waiver_processing_fixture',
        },
      ]),
    supabase
      .from('waiver_wire_log')
      .insert([sharedPlayer, dropClaimPlayer, fullRosterPlayer].map((player) => ({
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        player_id: player.id,
        dropped_by_member_id: null,
        placed_on_waivers_at: placedOnWaiversAt,
        clears_at: clearsAt,
      }))),
  ])
  if (leagueError) throw new Error(`${label}: roster-size update failed: ${leagueError.message}`)
  if (deletePriorityError) throw new Error(`${label}: priority cleanup failed: ${deletePriorityError.message}`)
  if (rosterError) throw new Error(`${label}: roster seed failed: ${rosterError.message}`)
  if (waiverLogError) throw new Error(`${label}: waiver log seed failed: ${waiverLogError.message}`)

  const { error: priorityError } = await supabase.from('waiver_priorities').insert(priorityRows)
  if (priorityError) throw new Error(`${label}: priority seed failed: ${priorityError.message}`)

  const { data: claims, error: claimError } = await supabase
    .from('waiver_claims')
    .insert([
      {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: priorityOne.id,
        player_id: sharedPlayer.id,
        drop_player_id: null,
        priority_at_submission: 1,
        process_date: processDate,
      },
      {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: priorityTwo.id,
        player_id: sharedPlayer.id,
        drop_player_id: null,
        priority_at_submission: 2,
        process_date: processDate,
      },
      {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: priorityThree.id,
        player_id: dropClaimPlayer.id,
        drop_player_id: dropPlayer.id,
        priority_at_submission: 3,
        process_date: processDate,
      },
      {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: priorityFour.id,
        player_id: fullRosterPlayer.id,
        drop_player_id: null,
        priority_at_submission: 4,
        process_date: processDate,
      },
    ])
    .select('id, member_id, player_id')
  if (claimError) throw new Error(`${label}: claim seed failed: ${claimError.message}`)

  await backendJson(env, '/e2e/process-waivers')

  const [claimRows, priorityResult, rosterRows, transactionRows, waiverRows] = await Promise.all([
    fetchAll(supabase, 'waiver_claims', 'id, member_id, player_id, drop_player_id, status, failure_reason', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'waiver_priorities', 'member_id, priority', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'roster_players', 'member_id, player_id, acquired_via', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'roster_transactions', 'member_id, player_id, transaction_type, related_claim_id', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'waiver_wire_log', 'player_id, dropped_by_member_id, claimed_by_claim_id, clears_at, cleared_at', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
  ])

  const claimByMemberPlayer = new Map(claimRows.map((row) => [`${row.member_id}:${row.player_id}`, row]))
  const winningSharedClaim = claimByMemberPlayer.get(`${priorityOne.id}:${sharedPlayer.id}`)
  const losingSharedClaim = claimByMemberPlayer.get(`${priorityTwo.id}:${sharedPlayer.id}`)
  const dropClaim = claimByMemberPlayer.get(`${priorityThree.id}:${dropClaimPlayer.id}`)
  const failedRosterClaim = claimByMemberPlayer.get(`${priorityFour.id}:${fullRosterPlayer.id}`)
  if (winningSharedClaim?.status !== 'succeeded') failures.push(`${label}: priority-one shared claim status ${winningSharedClaim?.status ?? '<missing>'}; expected succeeded`)
  if (losingSharedClaim?.status !== 'failed_priority') failures.push(`${label}: priority-two shared claim status ${losingSharedClaim?.status ?? '<missing>'}; expected failed_priority`)
  if (dropClaim?.status !== 'succeeded') failures.push(`${label}: drop claim status ${dropClaim?.status ?? '<missing>'}; expected succeeded`)
  if (failedRosterClaim?.status !== 'failed_roster') failures.push(`${label}: full-roster claim status ${failedRosterClaim?.status ?? '<missing>'}; expected failed_roster`)

  const rosterSet = new Set(rosterRows.map((row) => `${row.member_id}:${row.player_id}`))
  if (!rosterSet.has(`${priorityOne.id}:${sharedPlayer.id}`)) failures.push(`${label}: shared player not rostered by priority-one winner`)
  if (!rosterSet.has(`${priorityThree.id}:${dropClaimPlayer.id}`)) failures.push(`${label}: drop-claim player not rostered by priority-three winner`)
  if (rosterSet.has(`${priorityThree.id}:${dropPlayer.id}`)) failures.push(`${label}: dropped player still rostered by priority-three winner`)
  if (rosterSet.has(`${priorityFour.id}:${fullRosterPlayer.id}`)) failures.push(`${label}: failed-roster player was rostered`)

  const priorityByMember = new Map(priorityResult.map((row) => [row.member_id, row.priority]))
  const expectedPriority = new Map([
    [priorityTwo.id, 2],
    [priorityFour.id, 4],
  ])
  for (const [memberId, expected] of expectedPriority) {
    const actual = priorityByMember.get(memberId)
    if (actual !== expected) failures.push(`${label}: waiver priority for ${memberId} is ${actual ?? '<missing>'}; expected ${expected}`)
  }
  // Both winners move to the back of the queue. Same-day winning claim groups
  // process in player-id order (arbitrary UUIDs), so 5/6 can land either way.
  const backOfQueue = [priorityByMember.get(priorityOne.id), priorityByMember.get(priorityThree.id)]
  if ([...backOfQueue].sort((a, b) => a - b).join(',') !== '5,6') {
    failures.push(`${label}: winners hold priorities ${backOfQueue.join('/')}; expected 5 and 6 in either order`)
  }

  const transactionSet = new Set(transactionRows.map((row) => `${row.member_id}:${row.player_id}:${row.transaction_type}`))
  if (!transactionSet.has(`${priorityOne.id}:${sharedPlayer.id}:waiver_add`)) failures.push(`${label}: missing priority-one waiver_add transaction`)
  if (!transactionSet.has(`${priorityThree.id}:${dropClaimPlayer.id}:waiver_add`)) failures.push(`${label}: missing drop-claim waiver_add transaction`)
  if (!transactionSet.has(`${priorityThree.id}:${dropPlayer.id}:waiver_drop`)) failures.push(`${label}: missing drop-claim waiver_drop transaction`)

  const waiverForShared = waiverRows.find((row) => row.player_id === sharedPlayer.id)
  const waiverForDropClaim = waiverRows.find((row) => row.player_id === dropClaimPlayer.id)
  const waiverForDropped = waiverRows.find((row) => row.player_id === dropPlayer.id && row.dropped_by_member_id === priorityThree.id)
  if (!waiverForShared?.cleared_at || waiverForShared.claimed_by_claim_id !== winningSharedClaim?.id) failures.push(`${label}: shared-player waiver log was not claimed by winning claim`)
  if (!waiverForDropClaim?.cleared_at || waiverForDropClaim.claimed_by_claim_id !== dropClaim?.id) failures.push(`${label}: drop-claim waiver log was not claimed by winning claim`)
  if (!waiverForDropped || waiverForDropped.cleared_at) failures.push(`${label}: dropped player was not placed back on waivers`)

  const artifact = {
    season,
    fixture,
    players: {
      sharedPlayer,
      dropClaimPlayer,
      fullRosterPlayer,
      dropPlayer,
      fillerPlayer,
    },
    claims,
    claimRows,
    priorityRows: priorityResult,
    rosterRows,
    transactionRows,
    waiverRows,
    failures,
  }
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`)
  await mkdir(artifactDir, { recursive: true })
  await writeFile(path.join(artifactDir, 'waiver-processing.json'), `${JSON.stringify(artifact, null, 2)}\n`)
  return artifact
}

const expectAuctionRpcError = async ({ supabase, label, args, pattern }) => {
  const { error } = await supabase.rpc('place_auction_bid_atomic', args)
  if (!error) {
    throw new Error(`D.SET.4: expected ${label} to fail`)
  }
  if (!pattern.test(error.message)) {
    throw new Error(`D.SET.4: ${label} failed with "${error.message}", expected ${pattern}`)
  }
  return error.message
}

export const assertAuctionBidValidation = async ({ supabase, leagueId, season }) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const members = await sortedLeagueMembers(supabase, leagueId)
  if (members.length < 2) throw new Error('D.SET.4: auction validation requires at least two league members')
  const player = await findAvailablePlayer(supabase, leagueId, currentSeason.id)

  const [
    { id: bidderOne, user_id: bidderOneUserId },
    { id: bidderTwo, user_id: bidderTwoUserId },
  ] = members
  const now = new Date().toISOString()
  const { error: cleanupDraftError } = await supabase
    .from('drafts')
    .update({ status: 'completed', completed_at: now })
    .eq('league_id', leagueId)
    .eq('league_season_id', currentSeason.id)
    .in('status', ['pending', 'in_progress', 'paused'])
  if (cleanupDraftError) throw new Error(`D.SET.4 auction draft cleanup: ${cleanupDraftError.message}`)

  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .insert({
      league_id: leagueId,
      league_season_id: currentSeason.id,
      draft_type: 'auction',
      status: 'in_progress',
      // Budget must cover the $1-per-remaining-active-slot reserve rule
      // (place_auction_bid_atomic): empty 20-slot roster -> reserve 19.
      budget_per_team: 30,
      started_at: now,
      current_nomination_order: 1,
    })
    .select('id')
    .single()
  if (draftError) throw new Error(`D.SET.4 auction draft insert: ${draftError.message}`)

  const [{ error: orderError }, { error: budgetError }] = await Promise.all([
    supabase.from('draft_orders').insert(members.map((member, index) => ({
      draft_id: draft.id,
      member_id: member.id,
      position: index + 1,
    }))),
    supabase.from('draft_budgets').insert(members.map((member) => ({
      draft_id: draft.id,
      member_id: member.id,
      initial_budget: 30,
      remaining: 30,
    }))),
  ])
  if (orderError) throw new Error(`D.SET.4 auction order insert: ${orderError.message}`)
  if (budgetError) throw new Error(`D.SET.4 auction budget insert: ${budgetError.message}`)

  const { data: nomination, error: nominationError } = await supabase
    .from('nominations')
    .insert({
      draft_id: draft.id,
      nominating_member_id: bidderOne,
      player_id: player.id,
      nomination_order: 1,
      status: 'open',
      current_bid_amount: 1,
      current_bidder_id: null,
      countdown_expires_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (nominationError) throw new Error(`D.SET.4 auction nomination insert: ${nominationError.message}`)

  const baseArgs = {
    p_draft_id: draft.id,
    p_nomination_id: nomination.id,
  }
  const rejected = {
    currentBid: await expectAuctionRpcError({
      supabase,
      label: 'bid at current amount',
      args: { ...baseArgs, p_member_id: bidderOne, p_amount: 1, p_user_id: bidderOneUserId },
      pattern: /Bid must exceed current bid/i,
    }),
    overBudget: await expectAuctionRpcError({
      supabase,
      label: 'bid over budget',
      args: { ...baseArgs, p_member_id: bidderOne, p_amount: 31, p_user_id: bidderOneUserId },
      pattern: /Insufficient budget/i,
    }),
  }

  const { error: firstBidError } = await supabase.rpc('place_auction_bid_atomic', {
    ...baseArgs,
    p_member_id: bidderOne,
    p_amount: 2,
    p_user_id: bidderOneUserId,
  })
  if (firstBidError) throw new Error(`D.SET.4 first valid auction bid: ${firstBidError.message}`)

  rejected.selfOverbid = await expectAuctionRpcError({
    supabase,
    label: 'self-overbid',
    args: { ...baseArgs, p_member_id: bidderOne, p_amount: 3, p_user_id: bidderOneUserId },
    pattern: /already the highest bidder/i,
  })

  const { error: secondBidError } = await supabase.rpc('place_auction_bid_atomic', {
    ...baseArgs,
    p_member_id: bidderTwo,
    p_amount: 3,
    p_user_id: bidderTwoUserId,
  })
  if (secondBidError) throw new Error(`D.SET.4 second valid auction bid: ${secondBidError.message}`)

  const { data: finalNomination, error: finalError } = await supabase
    .from('nominations')
    .select('current_bid_amount, current_bidder_id')
    .eq('id', nomination.id)
    .single()
  if (finalError) throw new Error(`D.SET.4 auction final nomination lookup: ${finalError.message}`)
  if (finalNomination.current_bid_amount !== 3 || finalNomination.current_bidder_id !== bidderTwo) {
    throw new Error(`D.SET.4: final high bid was ${finalNomination.current_bid_amount}/${finalNomination.current_bidder_id}; expected 3/${bidderTwo}`)
  }
  const { error: closeError } = await supabase
    .from('nominations')
    .update({
      status: 'sold',
      winning_member_id: bidderTwo,
      final_price: 3,
      countdown_expires_at: null,
      closed_at: new Date().toISOString(),
    })
    .eq('id', nomination.id)
  if (closeError) throw new Error(`D.SET.4 auction fixture close: ${closeError.message}`)

  const artifact = {
    draftId: draft.id,
    nominationId: nomination.id,
    playerId: player.id,
    bidderOne,
    bidderTwo,
    rejected,
    acceptedBids: [2, 3],
  }
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`)
  await mkdir(artifactDir, { recursive: true })
  await writeFile(
    path.join(artifactDir, 'auction-validation.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  return artifact
}

const assertWaiverPushNotification = async ({ supabase, env, state, leagueId, season, fakePort, resourceOwner }) => {
  if (!state?.runId || !Array.isArray(state.users) || state.users.length < 3) {
    throw new Error('D.X.1: waiver push scenario requires tests/e2e-state.json from npm run e2e:seed')
  }

  const label = 'D.X.1 waiver push'
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 3,
    resourceOwner,
    seasonYear: 6200 + season,
  })

  const recipientUser = state.users[2]
  const member = fixture.members[2]
  if (member.user_id !== recipientUser.id) {
    throw new Error(`${label}: fixture member/user mismatch for waiver push recipient`)
  }

  const tokenValue = `ExponentPushToken[e2e-waiver-${state.runId}-${season}]`
  const { data: previousProfile, error: profileReadError } = await supabase
    .from('profiles').select('push_token').eq('id', recipientUser.id).single()
  if (profileReadError) throw new Error(`${label} token read: ${profileReadError.message}`)
  resourceOwner.register(`push token ${recipientUser.id}`, async () => {
    const { error } = await supabase.from('profiles').update({ push_token: previousProfile.push_token }).eq('id', recipientUser.id)
    if (error) throw new Error(error.message)
  })
  const [{ error: profileError }, { error: leagueError }, { error: priorityError }] = await Promise.all([
    supabase
      .from('profiles')
      .update({ push_token: tokenValue })
      .eq('id', recipientUser.id),
    supabase
      .from('leagues')
      .update({ roster_size: 20 })
      .eq('id', fixture.league.id),
    supabase
      .from('waiver_priorities')
      .insert(fixture.members.map((fixtureMember, index) => ({
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: fixtureMember.id,
        priority: index + 1,
      }))),
  ])
  if (profileError) throw new Error(`${label} token setup: ${profileError.message}`)
  if (leagueError) throw new Error(`${label} league setup: ${leagueError.message}`)
  if (priorityError) throw new Error(`${label} priority seed: ${priorityError.message}`)

  const player = await findAvailablePlayer(supabase, fixture.league.id, fixture.leagueSeason.id)

  const now = new Date()
  // The processor only picks up claims whose waiver hold has cleared
  // (waiver_wire_log.clears_at <= now), so seed an already-cleared hold.
  const clearsAt = new Date(now.getTime() - 60 * 1000).toISOString()
  const { data: waiverLog, error: logError } = await supabase
    .from('waiver_wire_log')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      player_id: player.id,
      dropped_by_member_id: member.id,
      clears_at: clearsAt,
    })
    .select('id')
    .single()
  if (logError) throw new Error(`D.X.1 waiver log insert: ${logError.message}`)
  // An insert trigger stamps clears_at from league waiver rules; backdate it
  // after insert so the hold has already cleared.
  const { error: clearsError } = await supabase
    .from('waiver_wire_log')
    .update({ clears_at: clearsAt })
    .eq('id', waiverLog.id)
  if (clearsError) throw new Error(`D.X.1 waiver log clears_at: ${clearsError.message}`)

  const { data: claim, error: claimError } = await supabase
    .from('waiver_claims')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: member.id,
      player_id: player.id,
      drop_player_id: null,
      priority_at_submission: 3,
      process_date: todayET(),
    })
    .select('id')
    .single()
  if (claimError) throw new Error(`D.X.1 waiver claim insert: ${claimError.message}`)

  await backendJson(env, '/e2e/process-waivers')

  const response = await fetch(`http://127.0.0.1:${fakePort}/admin/pushes`)
  if (!response.ok) throw new Error(`D.X.1 waiver push capture returned ${response.status}`)
  const { pushes } = await response.json()
  const title = 'Waiver Claim Succeeded'
  const body = `${player.display_name} has been added to your roster.`
  const match = pushes?.find((push) => (
    push.body?.to === tokenValue &&
    push.body?.title === title &&
    push.body?.body === body
  ))
  if (!match) {
    const [claimRow, rosterRows] = await Promise.all([
      fetchSingle(supabase, 'waiver_claims', 'id, status, failure_reason, processed_at', { id: claim.id }),
      fetchAll(supabase, 'roster_players', 'member_id, player_id, acquired_via', {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
      }),
    ])
    await writeFile(
      path.join(ARTIFACT_ROOT, `season-${season}`, 'waiver-push-debug.json'),
      `${JSON.stringify({
        targetLeagueId: leagueId,
        fixture,
        claim: claimRow,
        rosterRows,
        expected: { tokenValue, title, body },
        pushes,
      }, null, 2)}\n`,
    )
    throw new Error(`D.X.1: waiver push was not captured for token ${tokenValue}`)
  }

  return {
    season,
    targetLeagueId: leagueId,
    fixtureLeagueId: fixture.league.id,
    fixtureSeasonId: fixture.leagueSeason.id,
    claimId: claim.id,
    waiverLogId: waiverLog.id,
    memberId: member.id,
    playerId: player.id,
    playerName: player.display_name,
    captured: match,
  }
}

export const assertDraftPushNotification = async ({ supabase, env, state, season, fakePort, resourceOwner }) => {
  const failures = []
  const label = 'D.X.1'
  const {
    fixture,
    draft,
    slots,
    rookies,
    expectedOrder,
  } = await createRookieDraftFixture({ supabase, env, state, season, label, resourceOwner })

  const firstSlot = slots[0]
  if (!firstSlot) throw new Error(`${label}: draft push fixture created no rookie draft slots`)
  const recipientMember = fixture.members.find((member) => member.id === firstSlot.member_id)
  if (!recipientMember) throw new Error(`${label}: draft push member lookup failed for ${firstSlot.member_id}`)

  const tokenValue = `ExponentPushToken[e2e-draft-${state.runId ?? 'run'}-${season}]`
  const { data: previousProfile, error: profileReadError } = await supabase
    .from('profiles').select('push_token').eq('id', recipientMember.user_id).single()
  if (profileReadError) throw new Error(`${label} draft push token read: ${profileReadError.message}`)
  resourceOwner.register(`push token ${recipientMember.user_id}`, async () => {
    const { error } = await supabase.from('profiles').update({ push_token: previousProfile.push_token }).eq('id', recipientMember.user_id)
    if (error) throw new Error(error.message)
  })
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ push_token: tokenValue })
    .eq('id', recipientMember.user_id)
  if (profileError) throw new Error(`${label} draft push token setup: ${profileError.message}`)

  await postJson(`http://127.0.0.1:${fakePort}/admin/clear-pushes`, {})
  const autoPickResult = await backendJson(env, `/e2e/${draft.id}/auto-pick`, { memberId: firstSlot.member_id })

  const response = await fetch(`http://127.0.0.1:${fakePort}/admin/pushes`)
  if (!response.ok) throw new Error(`${label} draft push capture returned ${response.status}`)
  const { pushes } = await response.json()
  const match = pushes?.find((push) => push.body?.to === tokenValue)
  if (!match) {
    failures.push(`${label}: no draft push notification captured for rookie auto-pick to token ${tokenValue}`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    draftId: draft.id,
    firstSlot,
    expectedFirstEightMemberIds: expectedOrder,
    recipientMemberId: recipientMember.id,
    recipientUserId: recipientMember.user_id,
    tokenValue,
    rookies,
    autoPickResult,
    captured: match ?? null,
    capturedPushes: pushes ?? [],
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'draft-push-notification.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  return { failures, artifact }
}

export const assertPushNotifications = async (params) => {
  const label = `season ${params.season} push notifications`
  const resourceOwner = createScenarioResourceOwner(label)
  let primaryError

  try {
    await postJson(`http://127.0.0.1:${params.fakePort}/admin/clear-pushes`, {})
    // The push pipeline is verified end-to-end by the real, server-emitted waiver
    // notification. (The former trade-push check drove the removed /notify/trade
    // endpoint; real trade notifications are now emitted server-side by the
    // /trades/* routes during the main soak.)
    const waiver = await assertWaiverPushNotification({ ...params, resourceOwner })

    await writeFile(
      path.join(ARTIFACT_ROOT, `season-${params.season}`, 'push-notifications.json'),
      `${JSON.stringify({ waiver }, null, 2)}\n`,
    )
  } catch (error) {
    primaryError = error
  }

  const cleanupError = await resourceOwner.dispose().catch((error) => error)
  throwWithCleanup(primaryError, cleanupError, label)
}

export const assertCorsPreflight = async (env) => {
  const origin = new URL(env.frontendUrl).origin
  const response = await fetch(backendUrl(env, '/e2e/status'), {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type,x-e2e-secret,authorization',
    },
  })
  if (!response.ok && response.status !== 204) {
    throw new Error(`D.X.3: CORS preflight returned ${response.status}`)
  }

  const allowOrigin = response.headers.get('access-control-allow-origin')
  if (allowOrigin !== origin && allowOrigin !== '*') {
    throw new Error(`D.X.3: CORS allow-origin was ${allowOrigin ?? '<missing>'}; expected ${origin}`)
  }

  const allowMethods = response.headers.get('access-control-allow-methods') ?? ''
  if (!allowMethods.split(',').map((method) => method.trim().toUpperCase()).includes('GET')) {
    throw new Error(`D.X.3: CORS allow-methods missing GET: ${allowMethods || '<missing>'}`)
  }

  const allowHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase()
  for (const header of ['content-type', 'x-e2e-secret', 'authorization']) {
    if (!allowHeaders.includes(header)) {
      throw new Error(`D.X.3: CORS allow-headers missing ${header}: ${allowHeaders || '<missing>'}`)
    }
  }
}

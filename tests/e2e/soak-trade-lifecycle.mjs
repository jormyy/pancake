import {
  ARTIFACT_ROOT,
  EXPECTED_DEFAULT_LINEUP_SLOTS,
  createDisposableLeagueFromSeedUsers,
  currentSeasonYear,
  ensureSleeperFixturePlayer,
  fetchAll,
  fetchSingle,
  path,
  readLeagueSettingsForClient,
  readLineupSlotsForClient,
  readPlayerBySleeperId,
  seededPlayerQuery,
  signInSupabaseClient,
  writeFile,
} from './soak-support.mjs'
import {
  backendAuthedJson,
  backendGetJson,
  backendJson,
  postJson,
  signInForAccessToken,
} from './soak-backend-support.mjs'
import {
  expectAuthedBackendError,
} from './soak-draft-playoff.mjs'

export const assertInjuryStatusFilterScenario = async ({ supabase, env, season, fakePort, resourceOwner }) => {
  const failures = []
  const label = 'D.SEA.2 injury'
  const fakeStateBefore = await (await fetch(`http://127.0.0.1:${fakePort}/admin/state`)).json()
  resourceOwner.register('fake upstream injuries', async () => {
    await Promise.all(['1001', '1002'].map((playerId) => postJson(
      `http://127.0.0.1:${fakePort}/admin/injury`,
      { playerId, injuryStatus: fakeStateBefore.players?.[playerId]?.injury_status ?? null },
    )))
  })
  const beforePlayers = await Promise.all([
    readPlayerBySleeperId(supabase, '1001', label),
    readPlayerBySleeperId(supabase, '1002', label),
  ])
  resourceOwner.register('injury fixture players', async () => {
    const failures = []
    for (const [sleeperId, before] of [['1001', beforePlayers[0]], ['1002', beforePlayers[1]]]) {
      const restoreFields = before ? {
        sportsdata_id: before.sportsdata_id,
        first_name: before.first_name,
        last_name: before.last_name,
        sleeper_id: before.sleeper_id,
        position: before.position,
        eligible_positions: before.eligible_positions,
        status: before.status,
        injury_status: before.injury_status,
        nba_team: before.nba_team,
        years_exp: before.years_exp,
      } : null
      const { error } = before
        ? await supabase.from('players').update(restoreFields).eq('id', before.id)
        : await supabase.from('players').delete().eq('sleeper_id', sleeperId)
      if (error) failures.push(new Error(`${sleeperId}: ${error.message}`))
    }
    if (failures.length > 0) throw new AggregateError(failures, 'injury fixture restore failed')
  })
  const expectedSleeperBaseUrl = `http://127.0.0.1:${fakePort}/v1`
  const backendStatus = await backendGetJson(env, '/e2e/status')
  if (backendStatus.sleeperBaseUrl !== expectedSleeperBaseUrl) {
    throw new Error(`${label}: backend SLEEPER_BASE_URL=${backendStatus.sleeperBaseUrl ?? '<missing>'}; expected ${expectedSleeperBaseUrl}`)
  }

  const scrambledFixture = await ensureSleeperFixturePlayer(supabase, {
    sleeperId: '1001',
    firstName: 'Ari',
    lastName: 'Glass',
    position: 'PG',
  }, label)
  const validFixture = await ensureSleeperFixturePlayer(supabase, {
    sleeperId: '1002',
    firstName: 'Ben',
    lastName: 'Pine',
    position: 'SG',
  }, label)
  const { error: statsCleanupError } = await supabase
    .from('player_game_stats')
    .delete()
    .in('player_id', [scrambledFixture.id, validFixture.id])
  if (statsCleanupError) throw new Error(`${label}: fixture stat cleanup failed: ${statsCleanupError.message}`)

  await postJson(`http://127.0.0.1:${fakePort}/admin/injury`, {
    playerId: '1001',
    injuryStatus: 'Scrambled',
  })
  await postJson(`http://127.0.0.1:${fakePort}/admin/injury`, {
    playerId: '1002',
    injuryStatus: 'Out',
  })

  const syncResult = await backendJson(env, '/e2e/sync-players')
  const fakeState = await (await fetch(`http://127.0.0.1:${fakePort}/admin/state`)).json()
  const expectedScrambled = fakeState.players?.['1001'] ?? {}
  const expectedValid = fakeState.players?.['1002'] ?? {}
  const scrambledPlayer = await readPlayerBySleeperId(supabase, '1001', label)
  const validPlayer = await readPlayerBySleeperId(supabase, '1002', label)

  if (scrambledPlayer?.injury_status != null) {
    failures.push(`${label}: fake Sleeper injury_status Scrambled persisted as ${scrambledPlayer.injury_status}; expected null`)
  }
  if (validPlayer?.injury_status !== 'Out') {
    failures.push(`${label}: fake Sleeper injury_status Out persisted as ${validPlayer?.injury_status ?? '<null>'}; expected Out`)
  }
  if (scrambledPlayer?.nba_team !== expectedScrambled.team || Number(scrambledPlayer?.years_exp) !== Number(expectedScrambled.years_exp)) {
    failures.push(`${label}: Scrambled fixture team/years_exp ${scrambledPlayer?.nba_team ?? '<null>'}/${scrambledPlayer?.years_exp ?? '<null>'}; expected ${expectedScrambled.team}/${expectedScrambled.years_exp}`)
  }
  if (validPlayer?.nba_team !== expectedValid.team || Number(validPlayer?.years_exp) !== Number(expectedValid.years_exp)) {
    failures.push(`${label}: valid injury fixture team/years_exp ${validPlayer?.nba_team ?? '<null>'}/${validPlayer?.years_exp ?? '<null>'}; expected ${expectedValid.team}/${expectedValid.years_exp}`)
  }

  const artifact = {
    season,
    fakeSleeperBaseUrl: expectedSleeperBaseUrl,
    syncResult,
    before: {
      scrambledFixture,
      validFixture,
    },
    after: {
      scrambledPlayer,
      validPlayer,
    },
    expected: {
      sleeperId1001: { ...expectedScrambled, upstreamInjuryStatus: 'Scrambled', persistedInjuryStatus: null },
      sleeperId1002: { ...expectedValid, upstreamInjuryStatus: 'Out', persistedInjuryStatus: 'Out' },
    },
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'injury-status-filter.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const tradeAcceptFixtureSeasonYear = () => 8100 + Number(Date.now().toString().slice(-6))

export const assertTradeAcceptanceAtomicityScenario = async ({ supabase, env, state, season, resourceOwner }) => {
  const failures = []
  const label = 'D.SEA.2 trade'
  const fixtureSeasonYear = tradeAcceptFixtureSeasonYear()
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 2,
    resourceOwner,
    seasonYear: fixtureSeasonYear,
  })
  const [proposer, recipient] = fixture.members

  const { data: players, error: playersError } = await seededPlayerQuery(supabase)
    .limit(2)
  if (playersError) throw new Error(`${label}: player fixture lookup failed: ${playersError.message}`)
  if ((players ?? []).length < 2) throw new Error(`${label}: requires at least two players in the test Supabase project`)
  const [proposerPlayer, recipientPlayer] = players

  const { error: rosterError } = await supabase.from('roster_players').insert([
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: proposer.id,
      player_id: proposerPlayer.id,
      acquired_via: 'draft',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: recipient.id,
      player_id: recipientPlayer.id,
      acquired_via: 'draft',
    },
  ])
  if (rosterError) throw new Error(`${label}: roster fixture insert failed: ${rosterError.message}`)

  const pickYear = fixtureSeasonYear + 2
  const { data: picks, error: picksError } = await supabase
    .from('draft_picks')
    .insert([
      {
        league_id: fixture.league.id,
        season_year: pickYear,
        round: 1,
        original_owner_id: proposer.id,
        current_owner_id: proposer.id,
      },
      {
        league_id: fixture.league.id,
        season_year: pickYear,
        round: 2,
        original_owner_id: recipient.id,
        current_owner_id: recipient.id,
      },
    ])
    .select('id, original_owner_id, current_owner_id, season_year, round')
  if (picksError) throw new Error(`${label}: draft-pick fixture insert failed: ${picksError.message}`)
  const proposerPick = picks.find((pick) => pick.original_owner_id === proposer.id)
  const recipientPick = picks.find((pick) => pick.original_owner_id === recipient.id)
  if (!proposerPick || !recipientPick) throw new Error(`${label}: draft-pick fixture did not return both picks`)

  const { data: trade, error: tradeError } = await supabase
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      proposer_member_id: proposer.id,
      recipient_member_id: recipient.id,
      status: 'pending',
      notes: 'E2E multi-asset trade acceptance',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`${label}: trade insert failed: ${tradeError.message}`)

  const tradeItems = [
    { trade_id: trade.id, side: 'proposer', player_id: proposerPlayer.id, pick_id: null },
    { trade_id: trade.id, side: 'proposer', player_id: null, pick_id: proposerPick.id },
    { trade_id: trade.id, side: 'recipient', player_id: recipientPlayer.id, pick_id: null },
    { trade_id: trade.id, side: 'recipient', player_id: null, pick_id: recipientPick.id },
  ]
  const { error: itemError } = await supabase.from('trade_items').insert(tradeItems)
  if (itemError) throw new Error(`${label}: trade item insert failed: ${itemError.message}`)

  const proposerToken = await signInForAccessToken(env, state.users[0].email, state.password)
  const recipientToken = await signInForAccessToken(env, state.users[1].email, state.password)
  const mismatchedMemberError = await expectAuthedBackendError({
    env,
    path: `/trades/${trade.id}/accept`,
    token: proposerToken,
    body: { memberId: recipient.id },
    label: `${label}: mismatched auth/member accept`,
    pattern: /403|404|Access denied|Member not found/i,
  })
  if (mismatchedMemberError) failures.push(mismatchedMemberError)

  const beforeAcceptTrade = await fetchSingle(
    supabase,
    'trades',
    'id, status, accepted_at, completed_at',
    { id: trade.id },
  )
  if (beforeAcceptTrade.status !== 'pending') {
    failures.push(`${label}: mismatched accept changed trade status to ${beforeAcceptTrade.status}; expected pending`)
  }

  const acceptResult = await backendAuthedJson(env, `/trades/${trade.id}/accept`, recipientToken, {
    memberId: recipient.id,
  })
  const replayError = await expectAuthedBackendError({
    env,
    path: `/trades/${trade.id}/accept`,
    token: recipientToken,
    body: { memberId: recipient.id },
    label: `${label}: replay accept`,
    pattern: /no longer pending|400|500/i,
  })
  if (replayError) failures.push(replayError)

  const [acceptedTrade, movedRoster, movedPicks, transactions] = await Promise.all([
    fetchSingle(supabase, 'trades', 'id, status, accepted_at, veto_window_expires_at, completed_at', { id: trade.id }),
    fetchAll(supabase, 'roster_players', 'id, member_id, player_id, acquired_via', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'draft_picks', 'id, current_owner_id, original_owner_id, season_year, round', {
      league_id: fixture.league.id,
      season_year: pickYear,
    }),
    fetchAll(supabase, 'roster_transactions', 'id, member_id, player_id, transaction_type, related_trade_id', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      related_trade_id: trade.id,
    }),
  ])

  const rosterByPlayer = new Map(movedRoster.map((row) => [row.player_id, row]))
  const picksById = new Map(movedPicks.map((pick) => [pick.id, pick]))
  if (acceptedTrade.status !== 'accepted' || !acceptedTrade.accepted_at || !acceptedTrade.veto_window_expires_at || acceptedTrade.completed_at) {
    failures.push(`${label}: accepted trade status=${acceptedTrade.status}, accepted_at=${acceptedTrade.accepted_at ?? '<null>'}, veto_window_expires_at=${acceptedTrade.veto_window_expires_at ?? '<null>'}, completed_at=${acceptedTrade.completed_at ?? '<null>'}; expected open veto window`)
  }
  if (rosterByPlayer.get(proposerPlayer.id)?.member_id !== proposer.id || rosterByPlayer.get(recipientPlayer.id)?.member_id !== recipient.id) {
    failures.push(`${label}: assets moved before veto window elapsed`)
  }
  if (picksById.get(proposerPick.id)?.current_owner_id !== proposer.id || picksById.get(recipientPick.id)?.current_owner_id !== recipient.id) {
    failures.push(`${label}: picks moved before veto window elapsed`)
  }
  if (transactions.length !== 0) {
    failures.push(`${label}: roster_transactions count=${transactions.length}; expected 0 before veto window completion`)
  }

  const { error: expireError } = await supabase
    .from('trades')
    .update({ veto_window_expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', trade.id)
  if (expireError) throw new Error(`${label}: expire veto window failed: ${expireError.message}`)
  const processResult = await backendJson(env, '/e2e/process-trades')

  const [completedTrade, completedRoster, completedPicks, completedTransactions] = await Promise.all([
    fetchSingle(supabase, 'trades', 'id, status, accepted_at, veto_window_expires_at, completed_at', { id: trade.id }),
    fetchAll(supabase, 'roster_players', 'id, member_id, player_id, acquired_via', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'draft_picks', 'id, current_owner_id, original_owner_id, season_year, round', {
      league_id: fixture.league.id,
      season_year: pickYear,
    }),
    fetchAll(supabase, 'roster_transactions', 'id, member_id, player_id, transaction_type, related_trade_id', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      related_trade_id: trade.id,
    }),
  ])

  const completedRosterByPlayer = new Map(completedRoster.map((row) => [row.player_id, row]))
  const completedPicksById = new Map(completedPicks.map((pick) => [pick.id, pick]))
  if (completedTrade.status !== 'completed' || !completedTrade.accepted_at || !completedTrade.completed_at) {
    failures.push(`${label}: completed trade status=${completedTrade.status}, accepted_at=${completedTrade.accepted_at ?? '<null>'}, completed_at=${completedTrade.completed_at ?? '<null>'}; expected completed timestamps`)
  }
  if (completedRosterByPlayer.get(proposerPlayer.id)?.member_id !== recipient.id) {
    failures.push(`${label}: proposer player moved to ${completedRosterByPlayer.get(proposerPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${recipient.id}`)
  }
  if (completedRosterByPlayer.get(recipientPlayer.id)?.member_id !== proposer.id) {
    failures.push(`${label}: recipient player moved to ${completedRosterByPlayer.get(recipientPlayer.id)?.member_id ?? '<missing>'}; expected proposer ${proposer.id}`)
  }
  if (completedRosterByPlayer.get(proposerPlayer.id)?.acquired_via !== 'trade' || completedRosterByPlayer.get(recipientPlayer.id)?.acquired_via !== 'trade') {
    failures.push(`${label}: moved players did not receive acquired_via=trade`)
  }
  if (completedPicksById.get(proposerPick.id)?.current_owner_id !== recipient.id) {
    failures.push(`${label}: proposer pick owner=${completedPicksById.get(proposerPick.id)?.current_owner_id ?? '<missing>'}; expected recipient ${recipient.id}`)
  }
  if (completedPicksById.get(recipientPick.id)?.current_owner_id !== proposer.id) {
    failures.push(`${label}: recipient pick owner=${completedPicksById.get(recipientPick.id)?.current_owner_id ?? '<missing>'}; expected proposer ${proposer.id}`)
  }
  if (completedTransactions.length !== 4) {
    failures.push(`${label}: roster_transactions count=${completedTransactions.length}; expected 4 trade in/out rows for two players`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    tradeId: trade.id,
    acceptResult,
    mismatchedMemberRejected: mismatchedMemberError == null,
    replayRejected: replayError == null,
    members: {
      proposer,
      recipient,
    },
    assets: {
      proposerPlayer,
      recipientPlayer,
      proposerPick,
      recipientPick,
    },
    after: {
      acceptedTrade,
      processResult,
      completedTrade,
      roster: completedRoster,
      picks: completedPicks,
      transactions: completedTransactions,
    },
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'trade-acceptance-atomicity.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

export const assertTradeVetoScenario = async ({ supabase, env, state, season, resourceOwner }) => {
  const label = 'D.SEA.2 trade veto'
  const failures = []
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 10,
    resourceOwner,
  })
  const [commissioner, proposer, recipient, ...voters] = fixture.members
  const acceptedAt = new Date().toISOString()
  const vetoWindowExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

  const createAcceptedTrade = async (notes) => {
    const { data, error } = await supabase
      .from('trades')
      .insert({
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        proposer_member_id: proposer.id,
        recipient_member_id: recipient.id,
        status: 'accepted',
        accepted_at: acceptedAt,
        veto_window_expires_at: vetoWindowExpiresAt,
        notes,
      })
      .select('id, status, vetoed_at')
      .single()
    if (error || !data) throw new Error(`${label}: accepted trade insert failed: ${error?.message ?? 'missing row'}`)
    return data
  }

  const thresholdTrade = await createAcceptedTrade('E2E member veto threshold')
  const commissionerTrade = await createAcceptedTrade('E2E commissioner veto')
  const tokens = await Promise.all(
    [commissioner, proposer, ...voters.slice(0, 4)].map((member) => {
      const user = state.users.find((candidate) => candidate.id === member.user_id)
      if (!user) throw new Error(`${label}: missing seeded user for member ${member.id}`)
      return signInForAccessToken(env, user.email, state.password)
    }),
  )
  const [commissionerToken, proposerToken, ...voterTokens] = tokens

  const partyVetoError = await expectAuthedBackendError({
    env,
    path: `/trades/${thresholdTrade.id}/veto`,
    token: proposerToken,
    body: { memberId: proposer.id },
    label: `${label}: trade party member veto`,
    pattern: /Trade parties cannot veto|400/i,
  })
  if (partyVetoError) failures.push(partyVetoError)

  for (const [index, voter] of voters.slice(0, 3).entries()) {
    const result = await backendAuthedJson(env, `/trades/${thresholdTrade.id}/veto`, voterTokens[index], {
      memberId: voter.id,
    })
    if (result.vetoed) {
      failures.push(`${label}: voter ${index + 1} vetoed trade before 50% threshold`)
    }
  }

  const beforeThreshold = await fetchSingle(supabase, 'trades', 'id, status, vetoed_at', { id: thresholdTrade.id })
  if (beforeThreshold.status !== 'accepted' || beforeThreshold.vetoed_at) {
    failures.push(`${label}: trade status=${beforeThreshold.status}, vetoed_at=${beforeThreshold.vetoed_at ?? '<null>'}; expected accepted before threshold`)
  }

  const thresholdResult = await backendAuthedJson(env, `/trades/${thresholdTrade.id}/veto`, voterTokens[3], {
    memberId: voters[3].id,
  })
  if (!thresholdResult.vetoed || thresholdResult.threshold !== 4 || thresholdResult.vetoCount !== 4) {
    failures.push(`${label}: threshold result=${JSON.stringify(thresholdResult)}; expected vetoed with count 4 threshold 4`)
  }

  const afterThreshold = await fetchSingle(supabase, 'trades', 'id, status, vetoed_at', { id: thresholdTrade.id })
  if (afterThreshold.status !== 'vetoed' || !afterThreshold.vetoed_at) {
    failures.push(`${label}: threshold trade status=${afterThreshold.status}, vetoed_at=${afterThreshold.vetoed_at ?? '<null>'}; expected vetoed`)
  }

  const commissionerResult = await backendAuthedJson(env, `/trades/${commissionerTrade.id}/veto`, commissionerToken, {
    memberId: commissioner.id,
  })
  if (!commissionerResult.vetoed) {
    failures.push(`${label}: commissioner veto did not immediately veto trade`)
  }

  const [afterCommissioner, vetoRows] = await Promise.all([
    fetchSingle(supabase, 'trades', 'id, status, vetoed_at', { id: commissionerTrade.id }),
    fetchAll(supabase, 'trade_vetos', 'id, trade_id, member_id, veto_type', {}),
  ])
  const scopedVetoRows = vetoRows.filter((row) => row.trade_id === thresholdTrade.id || row.trade_id === commissionerTrade.id)
  if (afterCommissioner.status !== 'vetoed' || !afterCommissioner.vetoed_at) {
    failures.push(`${label}: commissioner trade status=${afterCommissioner.status}, vetoed_at=${afterCommissioner.vetoed_at ?? '<null>'}; expected vetoed`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    thresholdTradeId: thresholdTrade.id,
    commissionerTradeId: commissionerTrade.id,
    partyVetoRejected: partyVetoError == null,
    thresholdResult,
    commissionerResult,
    afterThreshold,
    afterCommissioner,
    vetoRows: scopedVetoRows,
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'trade-veto-threshold.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

export const assertLeagueLifecycleScenario = async ({ supabase, env, state, season, resourceOwner }) => {
  const failures = []
  const label = 'D.SET.2'
  const users = state.users.slice(0, 10)
  const unique = `${state.runId ?? 'manual'}-${season}-${Date.now().toString(36)}`
  const commissioner = await signInSupabaseClient(env, users[0].email, state.password, label)
  const { data: createdLeague, error: createError } = await commissioner.rpc('create_league', {
    p_name: `Pancake E2E Lifecycle ${unique}`,
    p_team_name: `${label} Team 1`,
    p_auction_budget: 211,
  })
  if (createError) throw new Error(`${label}: create_league failed: ${createError.message}`)
  if (!createdLeague?.id) throw new Error(`${label}: create_league returned no league id`)
  resourceOwner.register(`league ${createdLeague.id}`, async () => {
    const { error } = await supabase.from('leagues').delete().eq('id', createdLeague.id)
    if (error) throw new Error(error.message)
  })
  if (!/^[A-Z0-9]{16}$/.test(createdLeague.invite_code ?? '')) {
    failures.push(`${label}: invite_code=${createdLeague.invite_code ?? '<missing>'}; expected 16 uppercase alnum chars`)
  }

  for (const [index, user] of users.slice(1).entries()) {
    const client = await signInSupabaseClient(env, user.email, state.password, label)
    const { error } = await client.rpc('join_league_by_invite_code', {
      p_invite_code: createdLeague.invite_code,
      p_team_name: `${label} Team ${index + 2}`,
    })
    if (error) failures.push(`${label}: join_league_by_invite_code failed for ${user.email}: ${error.message}`)
  }

  const [
    league,
    members,
    seasons,
    picks,
    slotRows,
  ] = await Promise.all([
    fetchSingle(supabase, 'leagues', 'id, invite_code, commissioner_id, auction_budget, status', { id: createdLeague.id }),
    fetchAll(supabase, 'league_members', 'id, user_id, role, team_name', { league_id: createdLeague.id }),
    fetchAll(supabase, 'league_seasons', 'id, season_year, is_current', { league_id: createdLeague.id }),
    fetchAll(supabase, 'draft_picks', 'id, season_year, round, original_owner_id, current_owner_id', { league_id: createdLeague.id }),
    fetchAll(supabase, 'lineup_slot_templates', 'slot_type, slot_count', { league_id: createdLeague.id }),
  ])

  if (league.commissioner_id !== users[0].id) {
    failures.push(`${label}: commissioner_id=${league.commissioner_id}; expected ${users[0].id}`)
  }
  if (league.auction_budget !== 211) {
    failures.push(`${label}: auction_budget=${league.auction_budget}; expected 211`)
  }
  if (members.length !== users.length) {
    failures.push(`${label}: league_members count=${members.length}; expected ${users.length}`)
  }
  const memberByUserId = new Map(members.map((member) => [member.user_id, member]))
  for (const [index, user] of users.entries()) {
    const member = memberByUserId.get(user.id)
    if (!member) {
      failures.push(`${label}: missing league_member for user ${user.email}`)
      continue
    }
    const expectedRole = index === 0 ? 'commissioner' : 'manager'
    if (member.role !== expectedRole) {
      failures.push(`${label}: member ${member.id} role=${member.role}; expected ${expectedRole}`)
    }
  }

  const currentSeasons = seasons.filter((row) => row.is_current)
  if (currentSeasons.length !== 1) {
    failures.push(`${label}: current season rows=${currentSeasons.length}; expected 1`)
  }
  const seasonYear = currentSeasons[0]?.season_year ?? currentSeasonYear()
  const minPickYear = seasonYear + 1
  const maxPickYear = seasonYear + 5
  const pickKeys = new Set(picks.map((pick) => `${pick.season_year}:${pick.round}:${pick.original_owner_id}:${pick.current_owner_id}`))
  for (const member of members) {
    for (let year = minPickYear; year <= maxPickYear; year += 1) {
      for (let round = 1; round <= 3; round += 1) {
        const key = `${year}:${round}:${member.id}:${member.id}`
        if (!pickKeys.has(key)) failures.push(`${label}: missing future pick ${key}`)
      }
    }
  }
  const expectedPickCount = members.length * 5 * 3
  if (picks.length !== expectedPickCount) {
    failures.push(`${label}: draft_picks count=${picks.length}; expected ${expectedPickCount}`)
  }

  const slotCounts = new Map(slotRows.map((slot) => [slot.slot_type, slot.slot_count]))
  for (const [slotType, slotCount] of Object.entries(EXPECTED_DEFAULT_LINEUP_SLOTS)) {
    if (slotCounts.get(slotType) !== slotCount) {
      failures.push(`${label}: lineup_slot_templates ${slotType}=${slotCounts.get(slotType) ?? '<missing>'}; expected ${slotCount}`)
    }
  }
  if (slotRows.length !== Object.keys(EXPECTED_DEFAULT_LINEUP_SLOTS).length) {
    failures.push(`${label}: lineup_slot_templates count=${slotRows.length}; expected ${Object.keys(EXPECTED_DEFAULT_LINEUP_SLOTS).length}`)
  }

  const artifact = {
    season,
    league: {
      id: league.id,
      invite_code: league.invite_code,
      status: league.status,
      commissioner_id: league.commissioner_id,
      auction_budget: league.auction_budget,
    },
    users: users.map((user) => ({ id: user.id, email: user.email })),
    memberCount: members.length,
    currentSeasons,
    pickWindow: { minPickYear, maxPickYear, count: picks.length, expectedPickCount },
    slots: Object.fromEntries(slotCounts),
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'league-lifecycle.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

export const assertCommissionerSettingsScenario = async ({ supabase, env, state, season, resourceOwner }) => {
  const failures = []
  const label = 'D.SET.3'
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 2,
    resourceOwner,
    status: 'setup',
  })
  const commissioner = await signInSupabaseClient(env, state.users[0].email, state.password, label)
  const manager = await signInSupabaseClient(env, state.users[1].email, state.password, label)
  const expectedScoring = {
    points: 1,
    rebounds: 1.25,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 0.5,
    field_goals_attempted: -0.25,
    field_goals_made: 0.5,
    free_throws_attempted: -0.25,
    free_throws_made: 0.5,
    triple_double: 5,
  }
  const expectedLeagueSettings = {
    scoring_settings: expectedScoring,
    roster_size: 17,
    ir_slots: 3,
    taxi_slots: 2,
    auction_budget: 240,
    playoff_start_week: 21,
  }
  const expectedSlots = [
    { slot_type: 'PG', slot_count: 2 },
    { slot_type: 'SG', slot_count: 2 },
    { slot_type: 'SF', slot_count: 2 },
    { slot_type: 'PF', slot_count: 2 },
    { slot_type: 'C', slot_count: 1 },
    { slot_type: 'G', slot_count: 1 },
    { slot_type: 'F', slot_count: 1 },
    { slot_type: 'UTIL', slot_count: 3 },
    { slot_type: 'BE', slot_count: 4 },
  ]

  const { error: leagueUpdateError } = await commissioner.rpc('update_league_settings_atomic', {
    p_league_id: fixture.league.id,
    p_settings: expectedLeagueSettings,
  })
  if (leagueUpdateError) {
    failures.push(`${label}: commissioner league settings update failed through authenticated RPC: ${leagueUpdateError.message}`)
  }

  const { error: slotsUpdateError } = await commissioner.rpc('update_lineup_slots_atomic', {
    p_league_id: fixture.league.id,
    p_slots: expectedSlots,
  })
  if (slotsUpdateError) {
    failures.push(`${label}: commissioner lineup slot update failed through authenticated RPC: ${slotsUpdateError.message}`)
  }

  const managerLeagueAttempt = await manager.rpc('update_league_settings_atomic', {
    p_league_id: fixture.league.id,
    p_settings: { roster_size: 99 },
  })
  const managerSlotAttempt = await manager.rpc('update_lineup_slots_atomic', {
    p_league_id: fixture.league.id,
    p_slots: [{ slot_type: 'PG', slot_count: 99 }],
  })
  if (!managerLeagueAttempt.error) {
    failures.push(`${label}: manager league settings RPC unexpectedly succeeded`)
  }
  if (!managerSlotAttempt.error) {
    failures.push(`${label}: manager lineup slot RPC unexpectedly succeeded`)
  }

  const managerLeague = await readLeagueSettingsForClient(manager, fixture.league.id, label)
  const managerSlots = await readLineupSlotsForClient(manager, fixture.league.id, label)
  const persistedLeague = await readLeagueSettingsForClient(supabase, fixture.league.id, label)
  const persistedSlots = await readLineupSlotsForClient(supabase, fixture.league.id, label)
  const slotCounts = new Map(managerSlots.map((slot) => [slot.slot_type, slot.slot_count]))
  const persistedSlotCounts = new Map(persistedSlots.map((slot) => [slot.slot_type, slot.slot_count]))

  if (managerLeague.roster_size !== expectedLeagueSettings.roster_size) {
    failures.push(`${label}: manager read roster_size=${managerLeague.roster_size}; expected propagated value ${expectedLeagueSettings.roster_size}`)
  }
  if (persistedLeague.roster_size !== expectedLeagueSettings.roster_size) {
    failures.push(`${label}: manager write changed roster_size to ${persistedLeague.roster_size}; expected commissioner-only value ${expectedLeagueSettings.roster_size}`)
  }
  if (managerLeague.ir_slots !== expectedLeagueSettings.ir_slots || managerLeague.taxi_slots !== expectedLeagueSettings.taxi_slots) {
    failures.push(`${label}: manager read IR/taxi slots ${managerLeague.ir_slots}/${managerLeague.taxi_slots}; expected ${expectedLeagueSettings.ir_slots}/${expectedLeagueSettings.taxi_slots}`)
  }
  if (managerLeague.auction_budget !== expectedLeagueSettings.auction_budget || managerLeague.playoff_start_week !== expectedLeagueSettings.playoff_start_week) {
    failures.push(`${label}: manager read budget/playoff week ${managerLeague.auction_budget}/${managerLeague.playoff_start_week}; expected ${expectedLeagueSettings.auction_budget}/${expectedLeagueSettings.playoff_start_week}`)
  }
  if (Number(managerLeague.scoring_settings?.triple_double) !== expectedScoring.triple_double) {
    failures.push(`${label}: manager read triple_double=${managerLeague.scoring_settings?.triple_double}; expected ${expectedScoring.triple_double}`)
  }
  for (const slot of expectedSlots) {
    if (slotCounts.get(slot.slot_type) !== slot.slot_count) {
      failures.push(`${label}: manager read ${slot.slot_type} slot_count=${slotCounts.get(slot.slot_type) ?? '<missing>'}; expected ${slot.slot_count}`)
    }
    if (persistedSlotCounts.get(slot.slot_type) !== slot.slot_count) {
      failures.push(`${label}: persisted ${slot.slot_type} slot_count=${persistedSlotCounts.get(slot.slot_type) ?? '<missing>'}; expected ${slot.slot_count}`)
    }
  }

  const artifact = {
    leagueId: fixture.league.id,
    commissionerUserId: state.users[0].id,
    managerUserId: state.users[1].id,
    expectedLeagueSettings,
    managerLeagueAttemptError: managerLeagueAttempt.error?.message ?? null,
    managerSlotAttemptError: managerSlotAttempt.error?.message ?? null,
    managerObservedLeague: managerLeague,
    managerObservedSlots: managerSlots,
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'commissioner-settings.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

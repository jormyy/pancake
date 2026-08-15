// AC-23 (decided by Michael 2026-08-14): the offseason is genuinely busy in
// every simulated season, not just a status flip. Between one season's reset
// and the next, a free-agent add, a drop, a processed waiver claim, a
// two-team player+pick trade, a multi-team trade, a commissioner settings
// change, and a full rookie draft all happen while the league is in the
// offseason window — and every one of them is asserted to survive the
// rollover into the next season.
import {
  ARTIFACT_ROOT,
  createDisposableLeagueFromSeedUsers,
  fetchSingle,
  mkdir,
  path,
  signInSupabaseClient,
  writeFile,
} from './soak-support.mjs'
import { backendJson } from './soak-backend-support.mjs'

const offseasonFixtureSeasonYear = () => 7_500_000 + Number(Date.now().toString().slice(-6))

const ROOKIE_POOL = Array.from({ length: 12 }, (_, index) => ({
  sportsdata_id: `e2e-offseason-rookie-${index + 1}`,
  first_name: 'Offseason',
  last_name: `Rookie ${index + 1}`,
  position: 'SG',
  eligible_positions: ['SG'],
  status: 'Active',
  nba_team: 'E2E',
  years_exp: 0,
  nba_draft_number: 90_100 + index,
}))

const rpc = async (client, name, params, label) => {
  const { data, error } = await client.rpc(name, params)
  if (error) throw new Error(`${label}: ${name} failed: ${error.message}`)
  return data
}

const insertPlayers = async (supabase, label, rows) => {
  const { data, error } = await supabase.from('players')
    .upsert(rows, { onConflict: 'sportsdata_id' })
    .select('id, sportsdata_id')
  if (error) throw new Error(`${label}: player fixture upsert failed: ${error.message}`)
  return rows.map((row) => data.find((inserted) => inserted.sportsdata_id === row.sportsdata_id))
}

const stageAndReset = async (supabase, env, label, leagueId) => {
  const { error } = await supabase.from('leagues').update({ status: 'playoffs' }).eq('id', leagueId)
  if (error) throw new Error(`${label}: playoff staging failed: ${error.message}`)
  return backendJson(env, '/e2e/advance-season', { leagueId })
}

const ownerOf = async (supabase, label, leagueSeasonId, playerId) => {
  const { data, error } = await supabase.from('roster_players')
    .select('member_id')
    .eq('league_season_id', leagueSeasonId)
    .eq('player_id', playerId)
    .maybeSingle()
  if (error) throw new Error(`${label}: owner lookup failed: ${error.message}`)
  return data?.member_id ?? null
}

export const assertOffseasonActivityScenario = async ({ supabase, env, state, season, resourceOwner }) => {
  const failures = []
  const label = 'AC-23'
  const fixtureSeasonYear = offseasonFixtureSeasonYear()
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 4,
    resourceOwner,
    seasonYear: fixtureSeasonYear,
  })
  const [m1, m2, m3, m4] = fixture.members

  // Roster players + a free agent, unique to this run.
  const runTag = `${season}-${fixtureSeasonYear}`
  const [p1, p2, p3, p4, freeAgent] = await insertPlayers(supabase, label, [
    ...[1, 2, 3, 4].map((index) => ({
      sportsdata_id: `e2e-offseason-roster-${runTag}-${index}`,
      first_name: 'Offseason',
      last_name: `Starter ${runTag} ${index}`,
      position: 'PF',
      eligible_positions: ['PF'],
      status: 'Active',
      nba_team: 'E2E',
    })),
    {
      sportsdata_id: `e2e-offseason-fa-${runTag}`,
      first_name: 'Offseason',
      last_name: `Pickup ${runTag}`,
      position: 'C',
      eligible_positions: ['C'],
      status: 'Active',
      nba_team: 'E2E',
    },
  ])
  await insertPlayers(supabase, label, ROOKIE_POOL)

  const rosterAssignments = [[m1, p1], [m2, p2], [m3, p3], [m4, p4]]
  const { error: rosterError } = await supabase.from('roster_players').insert(
    rosterAssignments.map(([member, player]) => ({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: member.id,
      player_id: player.id,
      acquired_via: 'e2e_offseason_fixture',
    })),
  )
  if (rosterError) throw new Error(`${label}: roster fixture insert failed: ${rosterError.message}`)

  const pickRows = []
  for (const member of fixture.members) {
    for (let year = fixtureSeasonYear + 1; year <= fixtureSeasonYear + 5; year += 1) {
      for (let round = 1; round <= 3; round += 1) {
        pickRows.push({
          league_id: fixture.league.id,
          season_year: year,
          round,
          original_owner_id: member.id,
          current_owner_id: member.id,
        })
      }
    }
  }
  const { error: pickError } = await supabase.from('draft_picks').insert(pickRows)
  if (pickError) throw new Error(`${label}: pick bank insert failed: ${pickError.message}`)

  const { error: standingsError } = await supabase.from('standings').insert(
    fixture.members.map((member, index) => ({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: member.id,
      week_number: 19,
      wins: 9 - index * 2,
      losses: 1 + index * 2,
      ties: 0,
      points_for: 1100 - index * 50,
      points_against: 900 + index * 50,
      max_possible_points: 1200,
      waiver_priority: index + 1,
    })),
  )
  if (standingsError) throw new Error(`${label}: standings fixture insert failed: ${standingsError.message}`)
  const { error: priorityError } = await supabase.from('waiver_priorities').insert(
    fixture.members.map((member, index) => ({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: member.id,
      priority: index + 1,
    })),
  )
  if (priorityError) throw new Error(`${label}: waiver priority fixture insert failed: ${priorityError.message}`)

  // Season N closes -> the busy offseason begins.
  const firstReset = await stageAndReset(supabase, env, label, fixture.league.id)
  if (firstReset.newYear !== fixtureSeasonYear + 1) {
    failures.push(`${label}: first reset year ${firstReset.newYear}; expected ${fixtureSeasonYear + 1}`)
    return { failures }
  }
  const offseasonSeasonId = firstReset.newSeasonId

  // 1. Free-agent add as a signed-in manager.
  const m3Client = await signInSupabaseClient(env, state.users[2].email, state.password, label)
  await rpc(m3Client, 'add_free_agent_atomic', {
    p_member_id: m3.id, p_league_id: fixture.league.id, p_player_id: freeAgent.id,
  }, `${label} offseason add`)

  // 2. Drop the pickup (lands on the waiver wire).
  const addedRoster = await fetchSingle(supabase, 'roster_players', 'id', {
    league_season_id: offseasonSeasonId, member_id: m3.id, player_id: freeAgent.id,
  })
  await rpc(m3Client, 'drop_player_atomic', { p_roster_player_id: addedRoster.id }, `${label} offseason drop`)
  await m3Client.auth.signOut()

  // 3. Waiver claim by another manager, processed same-offseason.
  await rpc(supabase, 'create_waiver_claim_atomic', {
    p_league_id: fixture.league.id, p_member_id: m4.id, p_player_id: freeAgent.id,
  }, `${label} offseason claim`)
  const { error: clearsError } = await supabase.from('waiver_wire_log')
    .update({ clears_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('league_id', fixture.league.id)
    .eq('player_id', freeAgent.id)
  if (clearsError) throw new Error(`${label}: waiver clears_at update failed: ${clearsError.message}`)
  const { error: processDateError } = await supabase.from('waiver_claims')
    .update({ process_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) })
    .eq('league_id', fixture.league.id)
    .eq('status', 'pending')
  if (processDateError) throw new Error(`${label}: claim process_date update failed: ${processDateError.message}`)
  await backendJson(env, '/e2e/process-waivers')
  if (await ownerOf(supabase, label, offseasonSeasonId, freeAgent.id) !== m4.id) {
    failures.push(`${label}: processed offseason waiver claim did not roster the player on the claimant`)
  }

  // 4. Two-team player + pick trade through the real trade RPCs.
  const tradedPick = await fetchSingle(supabase, 'draft_picks', 'id', {
    league_id: fixture.league.id,
    current_owner_id: m1.id,
    season_year: fixtureSeasonYear + 3,
    round: 1,
  })
  const twoTeamTradeId = await rpc(supabase, 'propose_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: offseasonSeasonId,
    p_proposer_member_id: m1.id,
    p_recipient_member_id: m2.id,
    p_offer_player_ids: [p1.id],
    p_offer_pick_ids: [tradedPick.id],
    p_request_player_ids: [p2.id],
    p_request_pick_ids: [],
    p_offer_faab_amount: 0,
    p_request_faab_amount: 0,
    p_notes: 'AC-23 offseason two-team trade',
    p_expires_at: null,
  }, `${label} two-team propose`)
  await rpc(supabase, 'accept_trade_atomic', {
    p_trade_id: twoTeamTradeId, p_accepting_member_id: m2.id,
  }, `${label} two-team accept`)
  const { error: twoTeamWindowError } = await supabase.from('trades')
    .update({ veto_window_expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('id', twoTeamTradeId)
    .eq('status', 'accepted')
  if (twoTeamWindowError) throw new Error(`${label}: two-team veto expiry failed: ${twoTeamWindowError.message}`)
  await backendJson(env, '/e2e/process-trades')

  // 5. Multi-team trade (three teams, routed player items) built on the
  // completed two-team trade's rosters.
  const multiTradeId = await rpc(supabase, 'propose_multi_team_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: offseasonSeasonId,
    p_proposer_member_id: m2.id,
    p_participant_member_ids: [m2.id, m3.id, m4.id],
    p_items: [
      { fromMemberId: m2.id, toMemberId: m3.id, playerId: p1.id },
      { fromMemberId: m3.id, toMemberId: m4.id, playerId: p3.id },
      { fromMemberId: m4.id, toMemberId: m2.id, playerId: p4.id },
    ],
    p_notes: 'AC-23 offseason multi-team trade',
    p_expires_at: null,
  }, `${label} multi-team propose`)
  await rpc(supabase, 'accept_trade_atomic', { p_trade_id: multiTradeId, p_accepting_member_id: m3.id }, `${label} multi accept m3`)
  await rpc(supabase, 'accept_trade_atomic', { p_trade_id: multiTradeId, p_accepting_member_id: m4.id }, `${label} multi accept m4`)

  const { error: windowError } = await supabase.from('trades')
    .update({ veto_window_expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('id', multiTradeId)
    .eq('status', 'accepted')
  if (windowError) throw new Error(`${label}: veto window expiry failed: ${windowError.message}`)
  await backendJson(env, '/e2e/process-trades')

  const expectedOwners = [
    [p2.id, m1.id, 'two-team trade return player'],
    [p1.id, m3.id, 'multi-team routed player (via two-team, then multi)'],
    [p3.id, m4.id, 'multi-team routed player'],
    [p4.id, m2.id, 'multi-team routed player'],
  ]
  for (const [playerId, memberId, what] of expectedOwners) {
    if (await ownerOf(supabase, label, offseasonSeasonId, playerId) !== memberId) {
      failures.push(`${label}: ${what} not on the expected roster after offseason trades`)
    }
  }
  const pickAfterTrade = await fetchSingle(supabase, 'draft_picks', 'current_owner_id', { id: tradedPick.id })
  if (pickAfterTrade.current_owner_id !== m2.id) {
    failures.push(`${label}: traded pick did not move in the pick ledger`)
  }

  // 6. Commissioner settings change through the real authenticated RPC.
  const commissionerClient = await signInSupabaseClient(env, state.users[0].email, state.password, label)
  await rpc(commissionerClient, 'update_league_settings_atomic', {
    p_league_id: fixture.league.id,
    p_settings: { weekly_add_limit: 9 },
  }, `${label} settings change`)
  await commissionerClient.auth.signOut()

  // 7. Rookie draft, started and auto-completed in the offseason.
  const draftResult = await backendJson(env, '/e2e/start-rookie-draft', { leagueId: fixture.league.id })
  const draftId = draftResult.draft?.id
  if (!draftId) throw new Error(`${label}: rookie draft did not start: ${JSON.stringify(draftResult)}`)
  for (let picks = 0; picks < 20; picks += 1) {
    const { data: nextPick, error: nextError } = await supabase.from('snake_draft_picks')
      .select('id, member_id')
      .eq('draft_id', draftId)
      .is('player_id', null)
      .is('skipped_at', null)
      .order('overall_pick', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (nextError) throw new Error(`${label}: next pick lookup failed: ${nextError.message}`)
    if (!nextPick) break
    await backendJson(env, `/e2e/${draftId}/auto-pick`, { memberId: nextPick.member_id })
  }
  const { count: openSlots, error: openError } = await supabase.from('snake_draft_picks')
    .select('id', { count: 'exact', head: true })
    .eq('draft_id', draftId)
    .is('player_id', null)
  if (openError) throw new Error(`${label}: open slot count failed: ${openError.message}`)
  if ((openSlots ?? 0) > 0) failures.push(`${label}: rookie draft left ${openSlots} unfilled slots`)
  const { data: draftedRows, error: draftedError } = await supabase.from('snake_draft_picks')
    .select('member_id, player_id').eq('draft_id', draftId)
  if (draftedError) throw new Error(`${label}: drafted rows lookup failed: ${draftedError.message}`)

  // Season N+1 closes: everything the offseason produced must survive.
  const { error: reseedError } = await supabase.from('standings').insert(
    fixture.members.map((member, index) => ({
      league_id: fixture.league.id,
      league_season_id: offseasonSeasonId,
      member_id: member.id,
      week_number: 19,
      wins: 5,
      losses: 5,
      ties: 0,
      points_for: 1000 - index,
      points_against: 1000,
      max_possible_points: 1100,
      waiver_priority: index + 1,
    })),
  )
  if (reseedError) throw new Error(`${label}: second-season standings insert failed: ${reseedError.message}`)
  const secondReset = await stageAndReset(supabase, env, label, fixture.league.id)
  if (secondReset.newYear !== fixtureSeasonYear + 2) {
    failures.push(`${label}: second reset year ${secondReset.newYear}; expected ${fixtureSeasonYear + 2}`)
    return { failures }
  }
  const nextSeasonId = secondReset.newSeasonId

  for (const [playerId, memberId, what] of [
    ...expectedOwners,
    [freeAgent.id, m4.id, 'offseason waiver pickup'],
  ]) {
    if (await ownerOf(supabase, label, nextSeasonId, playerId) !== memberId) {
      failures.push(`${label}: ${what} did not survive the rollover into the next season`)
    }
  }
  for (const drafted of draftedRows ?? []) {
    if (await ownerOf(supabase, label, nextSeasonId, drafted.player_id) !== drafted.member_id) {
      failures.push(`${label}: drafted rookie did not survive the rollover on the picking team`)
    }
  }
  const pickAfterRollover = await fetchSingle(supabase, 'draft_picks', 'current_owner_id', { id: tradedPick.id })
  if (pickAfterRollover.current_owner_id !== m2.id) {
    failures.push(`${label}: traded pick ownership did not survive the rollover`)
  }
  const leagueAfter = await fetchSingle(supabase, 'leagues', 'weekly_add_limit', { id: fixture.league.id })
  if (leagueAfter.weekly_add_limit !== 9) {
    failures.push(`${label}: commissioner settings change did not survive the rollover`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    fixtureSeasonYear,
    offseasonSeasonId,
    nextSeasonId,
    twoTeamTradeId,
    multiTradeId,
    draftId,
    draftedCount: (draftedRows ?? []).length,
    failures,
  }
  await mkdir(path.join(ARTIFACT_ROOT, `season-${season}`), { recursive: true })
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'offseason-activity.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  return { failures, artifact }
}

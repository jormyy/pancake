import {
  ARTIFACT_ROOT,
  createDisposableLeagueFromSeedUsers,
  ensureSyntheticSeasonWeeks,
  errorMessage,
  fetchAll,
  path,
  writeFile,
} from './soak-support.mjs'
import {
  backendAuthedJson,
  backendJson,
  signInForAccessToken,
} from './soak-backend-support.mjs'

const rookieFixtureSeasonYear = () => 7000 + Number(Date.now().toString().slice(-6))

export const expectAuthedBackendError = async ({ env, path, token, body, label, pattern }) => {
  try {
    await backendAuthedJson(env, path, token, body)
    return `${label}: expected request to fail`
  } catch (error) {
    const message = errorMessage(error)
    return pattern.test(message) ? null : `${label}: failed with "${message}", expected ${pattern}`
  }
}

const findRookieDraftCandidates = async ({ supabase, leagueId, leagueSeasonId, draftId, count, label }) => {
  const [{ data: players, error: playersError }, rosterRows, pickedRows] = await Promise.all([
    supabase
      .from('players')
      .select('id, display_name, nba_draft_number, years_exp')
      .not('nba_draft_number', 'is', null)
      .eq('years_exp', 0)
      .order('nba_draft_number', { ascending: true })
      .order('id', { ascending: true })
      .limit(250),
    fetchAll(supabase, 'roster_players', 'player_id', {
      league_id: leagueId,
      league_season_id: leagueSeasonId,
    }),
    fetchAll(supabase, 'snake_draft_picks', 'player_id', { draft_id: draftId }),
  ])
  if (playersError) throw new Error(`${label}: rookie player lookup failed: ${playersError.message}`)

  const rosteredIds = new Set(rosterRows.map((row) => row.player_id))
  const pickedIds = new Set(pickedRows.flatMap((row) => row.player_id ? [row.player_id] : []))
  const candidates = (players ?? [])
    .filter((player) => !rosteredIds.has(player.id) && !pickedIds.has(player.id))
    .slice(0, count)
  if (candidates.length < count) {
    throw new Error(`${label}: requires at least ${count} rookie-eligible available players`)
  }
  return candidates
}

export const createRookieDraftFixture = async ({ supabase, env, state, season, label }) => {
  const fixtureSeasonYear = rookieFixtureSeasonYear()
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 4,
    seasonYear: fixtureSeasonYear,
  })
  const [member1, member2, member3, member4] = fixture.members
  const previousSeasonYear = fixtureSeasonYear - 1

  const { error: leagueStatusError } = await supabase
    .from('leagues')
    .update({ status: 'offseason' })
    .eq('id', fixture.league.id)
  if (leagueStatusError) throw new Error(`${label}: league offseason update failed: ${leagueStatusError.message}`)

  const { data: previousSeason, error: previousSeasonError } = await supabase
    .from('league_seasons')
    .insert({
      league_id: fixture.league.id,
      season_year: previousSeasonYear,
      is_current: false,
    })
    .select('id')
    .single()
  if (previousSeasonError) throw new Error(`${label}: previous season insert failed: ${previousSeasonError.message}`)

  const standingsRows = [
    { member: member4, wins: 1, pointsFor: 800, priority: 1 },
    { member: member3, wins: 3, pointsFor: 900, priority: 2 },
    { member: member2, wins: 5, pointsFor: 1000, priority: 3 },
    { member: member1, wins: 7, pointsFor: 1100, priority: 4 },
  ].map((row) => ({
    league_id: fixture.league.id,
    league_season_id: previousSeason.id,
    member_id: row.member.id,
    week_number: 19,
    wins: row.wins,
    losses: 10 - row.wins,
    ties: 0,
    points_for: row.pointsFor,
    points_against: 1000,
    max_possible_points: row.pointsFor + 100,
    waiver_priority: row.priority,
  }))
  const { error: standingsError } = await supabase.from('standings').insert(standingsRows)
  if (standingsError) throw new Error(`${label}: previous standings insert failed: ${standingsError.message}`)

  const pickRows = []
  for (const member of fixture.members) {
    for (let round = 1; round <= 3; round += 1) {
      pickRows.push({
        league_id: fixture.league.id,
        season_year: fixtureSeasonYear,
        round,
        original_owner_id: member.id,
        current_owner_id: member.id,
      })
    }
  }
  const { error: pickError } = await supabase.from('draft_picks').insert(pickRows)
  if (pickError) throw new Error(`${label}: draft pick asset insert failed: ${pickError.message}`)

  const { draft } = await backendJson(env, '/e2e/start-rookie-draft', { leagueId: fixture.league.id })
  const { data: pickSlots, error: slotsError } = await supabase
    .from('snake_draft_picks')
    .select('id, overall_pick, round, pick_in_round, member_id, player_id, picked_at, draft_pick_id')
    .eq('draft_id', draft.id)
    .order('overall_pick', { ascending: true })
  if (slotsError) throw new Error(`${label}: draft slot read failed: ${slotsError.message}`)
  const slots = pickSlots ?? []
  const expectedOrder = [member4.id, member3.id, member2.id, member1.id, member1.id, member2.id, member3.id, member4.id]
  const rookies = await findRookieDraftCandidates({
    supabase,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    draftId: draft.id,
    count: 2,
    label,
  })

  return {
    fixture,
    previousSeason,
    fixtureSeasonYear,
    draft,
    slots,
    rookies,
    expectedOrder,
  }
}

export const assertRookieDraftAutoPickScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SEA.5'
  const {
    fixture,
    previousSeason,
    fixtureSeasonYear,
    draft,
    slots,
    rookies,
    expectedOrder,
  } = await createRookieDraftFixture({ supabase, env, state, season, label })

  for (const [index, expectedMemberId] of expectedOrder.entries()) {
    if (slots[index]?.member_id !== expectedMemberId) {
      failures.push(`${label}: slot ${index + 1} member_id=${slots[index]?.member_id ?? '<missing>'}; expected inverse-standings snake member ${expectedMemberId}`)
    }
  }
  if (slots.length !== fixture.members.length * 3) {
    failures.push(`${label}: rookie draft created ${slots.length} slots; expected ${fixture.members.length * 3}`)
  }
  if (slots.some((slot) => !slot.draft_pick_id)) {
    failures.push(`${label}: one or more rookie draft slots are missing linked draft_pick_id assets`)
  }

  const firstSlot = slots[0]
  const expectedAutoPickPlayer = rookies[0]
  const autoPickResult = await backendJson(env, `/e2e/${draft.id}/auto-pick`, { memberId: firstSlot.member_id })
  const { data: pickedSlot, error: pickedSlotError } = await supabase
    .from('snake_draft_picks')
    .select('id, player_id, picked_at, draft_pick_id')
    .eq('id', firstSlot.id)
    .single()
  if (pickedSlotError || !pickedSlot) throw new Error(`${label}: picked slot read failed: ${pickedSlotError?.message ?? 'missing row'}`)
  if (pickedSlot.player_id !== expectedAutoPickPlayer.id) {
    failures.push(`${label}: auto-pick selected ${pickedSlot.player_id}; expected lowest nba_draft_number player ${expectedAutoPickPlayer.id}`)
  }
  if (!pickedSlot.picked_at) {
    failures.push(`${label}: auto-pick did not stamp picked_at immediately`)
  }
  if (autoPickResult.newPlayerId !== expectedAutoPickPlayer.id) {
    failures.push(`${label}: auto-pick response newPlayerId=${autoPickResult.newPlayerId}; expected ${expectedAutoPickPlayer.id}`)
  }

  const { data: usedPick, error: usedPickError } = await supabase
    .from('draft_picks')
    .select('id, is_used, rookie_draft_id, used_at')
    .eq('id', firstSlot.draft_pick_id)
    .single()
  if (usedPickError || !usedPick) throw new Error(`${label}: used draft pick asset read failed: ${usedPickError?.message ?? 'missing row'}`)
  if (!usedPick.is_used || usedPick.rookie_draft_id !== draft.id || !usedPick.used_at) {
    failures.push(`${label}: auto-pick did not mark linked draft_pick asset used for draft ${draft.id}`)
  }

  const rosteredPlayer = rookies[1]
  const nextSlot = slots[1]
  const nextSlotMember = fixture.members.find((member) => member.id === nextSlot.member_id)
  const nextSlotUser = state.users.find((user) => user.id === nextSlotMember?.user_id)
  if (!nextSlotUser) throw new Error(`${label}: could not resolve seeded user for next pick member ${nextSlot.member_id}`)
  const { error: rosterError } = await supabase.from('roster_players').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: nextSlot.member_id,
    player_id: rosteredPlayer.id,
    acquired_via: 'e2e_rostered_rejection',
  })
  if (rosterError) throw new Error(`${label}: rostered rejection fixture insert failed: ${rosterError.message}`)

  const accessToken = await signInForAccessToken(env, nextSlotUser.email, state.password)
  const rosteredRejection = await expectAuthedBackendError({
    env,
    path: `/draft/${draft.id}/snake-pick`,
    token: accessToken,
    body: { memberId: nextSlot.member_id, playerId: rosteredPlayer.id },
    label: `${label}: already-rostered rookie pick`,
    pattern: /already on a roster/i,
  })
  if (rosteredRejection) failures.push(rosteredRejection)

  const { data: rosterRows, error: rosterReadError } = await supabase
    .from('roster_players')
    .select('id, member_id, player_id')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.leagueSeason.id)
    .eq('player_id', expectedAutoPickPlayer.id)
  if (rosterReadError) throw new Error(`${label}: auto-picked roster read failed: ${rosterReadError.message}`)
  if ((rosterRows ?? []).length !== 1 || rosterRows[0]?.member_id !== firstSlot.member_id) {
    failures.push(`${label}: auto-picked player roster rows ${JSON.stringify(rosterRows)}; expected one row for ${firstSlot.member_id}`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    previousSeasonId: previousSeason.id,
    fixtureSeasonYear,
    draftId: draft.id,
    expectedFirstEightMemberIds: expectedOrder,
    slots,
    rookies,
    autoPickResult,
    pickedSlot,
    usedPick,
    rosteredRejection: rosteredRejection ?? 'rejected as expected',
    rosterRows: rosterRows ?? [],
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'rookie-draft-auto-pick.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const createDisposablePlayoffLeague = async ({ supabase, state, season }) => {
  const playoffStartWeek = 20
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label: 'D.SEA.4',
    userCount: 10,
    playoffStartWeek,
  })
  await ensureSyntheticSeasonWeeks(supabase, fixture.leagueSeason.season_year, playoffStartWeek + 2, 'D.SEA.4')

  const regularSeasonRows = []
  for (const [index, member] of fixture.members.entries()) {
    const wins = fixture.members.length - index
    for (let win = 0; win < wins; win += 1) {
      const opponentOffset = (win % (fixture.members.length - 1)) + 1
      const opponent = fixture.members[(index + opponentOffset) % fixture.members.length]
      regularSeasonRows.push({
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        week_number: 1 + (win % (playoffStartWeek - 1)),
        matchup_type: 'regular_season',
        home_member_id: member.id,
        away_member_id: opponent.id,
        home_points: 200 - index,
        away_points: 50 + index,
        home_max_possible_points: 220 - index,
        away_max_possible_points: 70 + index,
        winner_member_id: member.id,
        is_finalized: true,
        finalized_at: new Date().toISOString(),
      })
    }
  }

  const { error: matchupError } = await supabase.from('matchups').insert(regularSeasonRows)
  if (matchupError) throw new Error(`D.SEA.4 regular-season fixture insert: ${matchupError.message}`)

  return {
    ...fixture,
    regularSeasonRows: regularSeasonRows.length,
  }
}

const playoffPairExists = (rows, homeId, awayId) => rows.some((row) => (
  row.home_member_id === homeId &&
  row.away_member_id === awayId
))

export const assertPlayoffBracketScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const fixture = await createDisposablePlayoffLeague({ supabase, state, season })
  const accessToken = await signInForAccessToken(env, state.users[0].email, state.password)
  let generateResult = null
  let advanceBeforeFinalized = null

  try {
    generateResult = await backendAuthedJson(env, '/playoffs/generate', accessToken, {
      leagueId: fixture.league.id,
    })
  } catch (error) {
    failures.push(`D.SEA.4: /playoffs/generate failed for disposable 10-team league: ${errorMessage(error)}`)
  }

  try {
    await backendAuthedJson(env, '/playoffs/advance', accessToken, {
      leagueId: fixture.league.id,
    })
    failures.push('D.SEA.4: /playoffs/advance did not block before prerequisite playoff games were finalized')
  } catch (error) {
    advanceBeforeFinalized = errorMessage(error)
  }

  const { data: bracketRows, error: bracketError } = await supabase
    .from('matchups')
    .select('id, week_number, matchup_type, home_member_id, away_member_id, winner_member_id, is_finalized')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.leagueSeason.id)
    .neq('matchup_type', 'regular_season')
    .order('week_number', { ascending: true })
    .order('matchup_type', { ascending: true })
  if (bracketError) {
    failures.push(`D.SEA.4: playoff bracket read failed: ${bracketError.message}`)
  }

  const bracket = bracketRows ?? []
  const quarterfinals = bracket.filter((row) => row.matchup_type === 'playoff_quarterfinal')
  const semifinals = bracket.filter((row) => row.matchup_type === 'playoff_semifinal')
  const [seed1, seed2, seed3, seed4, seed5, seed6] = fixture.members
  const expectedQuarterfinals = [
    [seed3, seed6],
    [seed4, seed5],
  ]

  if (quarterfinals.length !== 2) {
    failures.push(`D.SEA.4: 10-team playoff bracket created ${quarterfinals.length} quarterfinals; expected 2 for seeds 3v6 and 4v5 with seeds 1 and 2 on bye`)
  }
  for (const [home, away] of expectedQuarterfinals) {
    if (!playoffPairExists(quarterfinals, home.id, away.id)) {
      failures.push(`D.SEA.4: missing expected quarterfinal ${home.team_name} vs ${away.team_name}`)
    }
  }

  const qfParticipants = new Set(quarterfinals.flatMap((row) => [row.home_member_id, row.away_member_id]))
  if (qfParticipants.has(seed1.id) || qfParticipants.has(seed2.id)) {
    failures.push('D.SEA.4: seed 1 or seed 2 appeared in the quarterfinal round instead of receiving a bye')
  }
  if (semifinals.length > 0 && quarterfinals.length === 0) {
    failures.push(`D.SEA.4: generated ${semifinals.length} semifinal rows directly; 10-team leagues must generate a top-6 bracket with a quarterfinal round first`)
  }

  const artifact = {
    season,
    disposableLeagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    regularSeasonRows: fixture.regularSeasonRows,
    expected: {
      teamCount: 10,
      firstRound: 'top-6 bracket: seed 3 vs seed 6 and seed 4 vs seed 5; seeds 1 and 2 bye',
    },
    seeds: fixture.members.map((member, index) => ({
      seed: index + 1,
      memberId: member.id,
      teamName: member.team_name,
    })),
    generateResult,
    advanceBeforeFinalized,
    bracket,
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'playoff-bracket.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const insertTiebreakerRows = async (supabase, fixture) => {
  const [seed1, seed2, seed3, seed4] = fixture.members
  const rows = [
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 1,
      matchup_type: 'regular_season',
      home_member_id: seed1.id,
      away_member_id: seed2.id,
      home_points: 100,
      away_points: 100,
      home_max_possible_points: 140,
      away_max_possible_points: 180,
      winner_member_id: seed1.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 2,
      matchup_type: 'regular_season',
      home_member_id: seed3.id,
      away_member_id: seed4.id,
      home_points: 100,
      away_points: 100,
      home_max_possible_points: 130,
      away_max_possible_points: 160,
      winner_member_id: seed3.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 3,
      matchup_type: 'regular_season',
      home_member_id: seed2.id,
      away_member_id: seed3.id,
      home_points: 100,
      away_points: 100,
      home_max_possible_points: 180,
      away_max_possible_points: 130,
      winner_member_id: seed2.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 4,
      matchup_type: 'regular_season',
      home_member_id: seed4.id,
      away_member_id: seed1.id,
      home_points: 100,
      away_points: 100,
      home_max_possible_points: 160,
      away_max_possible_points: 140,
      winner_member_id: seed4.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    },
  ]
  const { error } = await supabase.from('matchups').insert(rows)
  if (error) throw new Error(`D.SEA.3 tiebreaker fixture insert: ${error.message}`)
  return rows
}

const insertFullRpsTieRows = async (supabase, fixture) => {
  const [seed1, seed2, seed3, seed4] = fixture.members
  const baseRows = [
    [seed1, seed2, seed1, 1],
    [seed3, seed4, seed3, 2],
    [seed2, seed3, seed2, 3],
    [seed4, seed1, seed4, 4],
  ]
  const rows = baseRows.map(([home, away, winner, week]) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    week_number: week,
    matchup_type: 'regular_season',
    home_member_id: home.id,
    away_member_id: away.id,
    home_points: 100,
    away_points: 100,
    home_max_possible_points: 150,
    away_max_possible_points: 150,
    winner_member_id: winner.id,
    is_finalized: true,
    finalized_at: new Date().toISOString(),
  }))
  const { error } = await supabase.from('matchups').insert(rows)
  if (error) throw new Error(`D.SEA.3 RPS fixture insert: ${error.message}`)
  return rows
}

export const assertStandingsTiebreakerScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const maxFixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label: 'D.SEA.3',
    userCount: 4,
    playoffStartWeek: 20,
  })
  await ensureSyntheticSeasonWeeks(supabase, maxFixture.leagueSeason.season_year, 21, 'D.SEA.3')
  const fixtureRows = await insertTiebreakerRows(supabase, maxFixture)
  const [, expectedSeed1, expectedSeed4, expectedSeed2] = maxFixture.members
  const expectedSeed3 = maxFixture.members[0]
  const accessToken = await signInForAccessToken(env, state.users[0].email, state.password)
  let generateResult = null

  try {
    generateResult = await backendAuthedJson(env, '/playoffs/generate', accessToken, {
      leagueId: maxFixture.league.id,
    })
  } catch (error) {
    failures.push(`D.SEA.3: /playoffs/generate failed for disposable tiebreaker league: ${errorMessage(error)}`)
  }

  const { data: semis, error: semisError } = await supabase
    .from('matchups')
    .select('id, week_number, matchup_type, home_member_id, away_member_id, winner_member_id, is_finalized')
    .eq('league_id', maxFixture.league.id)
    .eq('league_season_id', maxFixture.leagueSeason.id)
    .eq('matchup_type', 'playoff_semifinal')
    .order('created_at', { ascending: true })
  if (semisError) {
    failures.push(`D.SEA.3: semifinal read failed: ${semisError.message}`)
  }

  const bracket = semis ?? []
  if (bracket.length !== 2) {
    failures.push(`D.SEA.3: tiebreaker bracket created ${bracket.length} semifinals; expected 2`)
  }
  const expectedPairs = [
    [expectedSeed1, expectedSeed4],
    [expectedSeed2, expectedSeed3],
  ]
  for (const [home, away] of expectedPairs) {
    if (!playoffPairExists(bracket, home.id, away.id)) {
      failures.push(`D.SEA.3: missing expected tiebreaker semifinal ${home.team_name} vs ${away.team_name}`)
    }
  }

  const { data: rpsRows, error: rpsError } = await supabase
    .from('rps_challenges')
    .select('id, member_a_id, member_b_id, winner_member_id, status, context')
    .eq('league_id', maxFixture.league.id)
    .eq('league_season_id', maxFixture.leagueSeason.id)
  if (rpsError) {
    failures.push(`D.SEA.3: max-points scenario rps_challenges read failed: ${rpsError.message}`)
  }

  const rpsFixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label: 'D.SEA.3 RPS',
    userCount: 4,
    playoffStartWeek: 20,
  })
  await ensureSyntheticSeasonWeeks(supabase, rpsFixture.leagueSeason.season_year, 21, 'D.SEA.3 RPS')
  const rpsFixtureRows = await insertFullRpsTieRows(supabase, rpsFixture)
  let rpsGenerateResult = null
  try {
    rpsGenerateResult = await backendAuthedJson(env, '/playoffs/generate', accessToken, {
      leagueId: rpsFixture.league.id,
    })
  } catch (error) {
    failures.push(`D.SEA.3: /playoffs/generate failed for disposable RPS league: ${errorMessage(error)}`)
  }

  const { data: rpsTieRows, error: rpsTieError } = await supabase
    .from('rps_challenges')
    .select('id, member_a_id, member_b_id, winner_member_id, status, context')
    .eq('league_id', rpsFixture.league.id)
    .eq('league_season_id', rpsFixture.leagueSeason.id)
  if (rpsTieError) {
    failures.push(`D.SEA.3: RPS scenario rps_challenges read failed: ${rpsTieError.message}`)
  }
  if ((rpsTieRows ?? []).length === 0) {
    failures.push('D.SEA.3: no rps_challenges were created for standings ties that remain unresolved after wins, points_for, max_possible_points, and points_against')
  }

  const { data: rpsBracket, error: rpsBracketError } = await supabase
    .from('matchups')
    .select('id, week_number, matchup_type, home_member_id, away_member_id, winner_member_id, is_finalized')
    .eq('league_id', rpsFixture.league.id)
    .eq('league_season_id', rpsFixture.leagueSeason.id)
    .eq('matchup_type', 'playoff_semifinal')
  if (rpsBracketError) {
    failures.push(`D.SEA.3: RPS semifinal read failed: ${rpsBracketError.message}`)
  }
  if ((rpsBracket ?? []).length > 0 && (rpsTieRows ?? []).length === 0) {
    failures.push(`D.SEA.3: generated ${rpsBracket.length} playoff semifinals even though the four-way tie had no RPS resolution`)
  }

  const artifact = {
    season,
    maxPointsScenario: {
      disposableLeagueId: maxFixture.league.id,
      leagueSeasonId: maxFixture.leagueSeason.id,
      fixtureRows,
      generateResult,
      bracket,
      rpsChallenges: rpsRows ?? [],
    },
    rpsScenario: {
      disposableLeagueId: rpsFixture.league.id,
      leagueSeasonId: rpsFixture.leagueSeason.id,
      fixtureRows: rpsFixtureRows,
      generateResult: rpsGenerateResult,
      bracket: rpsBracket ?? [],
      rpsChallenges: rpsTieRows ?? [],
    },
    expected: {
      tiebreakerOrder: [
        'wins',
        'points_for',
        'max_possible_points',
        'points_against',
        'deterministic_tiebreaker_audit',
      ],
      maxPointsScenario: 'all four teams are 1-1 with equal points_for; max_possible_points should seed D.SEA.3 Seed 2 first, Seed 4 second, Seed 1 third, Seed 3 fourth',
      rpsScenario: 'all four teams are 1-1 with equal points_for, max_possible_points, and points_against; completed tiebreaker audit rows should be created while deterministic playoff seeding succeeds',
    },
    seeds: maxFixture.members.map((member, index) => ({
      expectedSeed: index + 1,
      memberId: member.id,
      teamName: member.team_name,
    })),
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'standings-tiebreakers.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

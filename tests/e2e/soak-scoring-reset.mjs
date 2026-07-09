import {
  ARTIFACT_ROOT,
  countRows,
  createDisposableLeagueFromSeedUsers,
  fetchAll,
  fetchSingle,
  path,
  seededPlayerQuery,
  writeFile,
} from './soak-support.mjs'
import {
  backendJson,
} from './soak-backend-support.mjs'

export const scoringFixtureSeasonYear = () => 6000 + Number(Date.now().toString().slice(-6))
export const scoringFixtureWeekNumber = (season) => 700 + season
export const scoringFixtureDate = (season, offsetDays = 0) => {
  const date = new Date(Date.UTC(2040, 0, 1 + season * 7 + offsetDays))
  return date.toISOString().split('T')[0]
}

export const calculateFixturePoints = (stats, settings) => {
  if (stats.did_not_play) return 0
  return Number((
    stats.points * (settings.points ?? 0) +
    stats.rebounds * (settings.rebounds ?? 0) +
    stats.assists * (settings.assists ?? 0) +
    stats.steals * (settings.steals ?? 0) +
    stats.blocks * (settings.blocks ?? 0) +
    stats.turnovers * (settings.turnovers ?? 0) +
    stats.three_pointers_made * (settings.three_pointers_made ?? 0) +
    stats.field_goals_made * (settings.field_goals_made ?? 0) +
    stats.field_goals_attempted * (settings.field_goals_attempted ?? 0) +
    stats.free_throws_made * (settings.free_throws_made ?? 0) +
    stats.free_throws_attempted * (settings.free_throws_attempted ?? 0) +
    (stats.double_double ? (settings.double_double ?? 0) : 0) +
    (stats.triple_double ? (settings.triple_double ?? 0) : 0)
  ).toFixed(2))
}

export const assertNumberEquals = (failures, label, actual, expected) => {
  const actualNumber = Number(actual ?? 0)
  if (Math.abs(actualNumber - expected) > 0.001) {
    failures.push(`${label}: ${actualNumber}; expected ${expected}`)
  }
}

export const readScoringMatchup = async (supabase, matchupId, label) => {
  const { data, error } = await supabase
    .from('matchups')
    .select('id, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id, is_finalized, finalized_at')
    .eq('id', matchupId)
    .single()
  if (error || !data) throw new Error(`${label}: matchup read failed: ${error?.message ?? 'missing row'}`)
  return data
}

export const assertWeeklyScoringFinalizationScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SEA.2'
  const fixtureSeasonYear = scoringFixtureSeasonYear()
  const weekNumber = scoringFixtureWeekNumber(season)
  const gameDate = scoringFixtureDate(season)
  const secondDate = scoringFixtureDate(season, 1)
  const scoringReferenceDate = `${gameDate}T12:00:00Z`
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 2,
    seasonYear: fixtureSeasonYear,
  })
  const [homeMember, awayMember] = fixture.members
  const scoringSettings = {
    points: 1,
    rebounds: 1.2,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 0.5,
    field_goals_made: 0.2,
    field_goals_attempted: -0.1,
    free_throws_made: 0.2,
    free_throws_attempted: -0.1,
    double_double: 2,
    triple_double: 5,
  }

  const { error: leagueUpdateError } = await supabase
    .from('leagues')
    .update({
      scoring_settings: scoringSettings,
      playoff_start_week: 20,
    })
    .eq('id', fixture.league.id)
  if (leagueUpdateError) throw new Error(`${label}: scoring settings update failed: ${leagueUpdateError.message}`)

  const { error: weekError } = await supabase
    .from('season_weeks')
    .upsert({
      season_year: fixtureSeasonYear,
      week_number: weekNumber,
      week_start: gameDate,
      week_end: secondDate,
    }, { onConflict: 'season_year,week_number' })
  if (weekError) throw new Error(`${label}: season week fixture insert failed: ${weekError.message}`)

  const { data: players, error: playersError } = await seededPlayerQuery(supabase)
    .limit(4)
  if (playersError) throw new Error(`${label}: player fixture lookup failed: ${playersError.message}`)
  if ((players ?? []).length < 4) throw new Error(`${label}: requires at least four players in the test Supabase project`)

  const [homeStarter, homeBench, awayStarter, awayBench] = players
  const { data: game, error: gameError } = await supabase
    .from('nba_games')
    .insert({
      sportsdata_game_id: `e2e-scoring-${fixtureSeasonYear}-${Date.now()}`,
      nba_game_id: `E2ESCORING${fixtureSeasonYear}`,
      season_year: fixtureSeasonYear,
      game_date: gameDate,
      week_number: weekNumber,
      home_team: 'E2H',
      away_team: 'E2A',
      status: 'Scheduled',
    })
    .select('id')
    .single()
  if (gameError) throw new Error(`${label}: game fixture insert failed: ${gameError.message}`)

  const { data: secondGame, error: secondGameError } = await supabase
    .from('nba_games')
    .insert({
      sportsdata_game_id: `e2e-scoring-second-${fixtureSeasonYear}-${Date.now()}`,
      nba_game_id: `E2ESCORINGSECOND${fixtureSeasonYear}`,
      season_year: fixtureSeasonYear,
      game_date: secondDate,
      week_number: weekNumber,
      home_team: 'E2H',
      away_team: 'E2A',
      status: 'Scheduled',
    })
    .select('id')
    .single()
  if (secondGameError) throw new Error(`${label}: second game fixture insert failed: ${secondGameError.message}`)

  const homeStarterStats = {
    player_id: homeStarter.id,
    game_id: game.id,
    season_year: fixtureSeasonYear,
    week_number: weekNumber,
    game_date: gameDate,
    points: 10,
    rebounds: 5,
    assists: 4,
    steals: 1,
    blocks: 2,
    turnovers: 3,
    three_pointers_made: 2,
    field_goals_made: 4,
    field_goals_attempted: 9,
    free_throws_made: 2,
    free_throws_attempted: 3,
    double_double: true,
    triple_double: false,
  }
  const awayStarterStats = {
    player_id: awayStarter.id,
    game_id: game.id,
    season_year: fixtureSeasonYear,
    week_number: weekNumber,
    game_date: gameDate,
    points: 12,
    rebounds: 3,
    assists: 2,
    steals: 0,
    blocks: 1,
    turnovers: 1,
    three_pointers_made: 1,
    field_goals_made: 5,
    field_goals_attempted: 11,
    free_throws_made: 1,
    free_throws_attempted: 2,
    double_double: false,
    triple_double: true,
  }
  const homeStarterSecondStats = {
    player_id: homeStarter.id,
    game_id: secondGame.id,
    season_year: fixtureSeasonYear,
    week_number: weekNumber,
    game_date: secondDate,
    points: 20,
    rebounds: 2,
    assists: 3,
    steals: 0,
    blocks: 1,
    turnovers: 2,
    three_pointers_made: 1,
    field_goals_made: 7,
    field_goals_attempted: 13,
    free_throws_made: 5,
    free_throws_attempted: 6,
    double_double: false,
    triple_double: false,
  }
  const benchStats = [
    {
      player_id: homeBench.id,
      game_id: game.id,
      season_year: fixtureSeasonYear,
      week_number: weekNumber,
      game_date: gameDate,
      points: 100,
      rebounds: 20,
      assists: 20,
      steals: 10,
      blocks: 10,
      turnovers: 0,
      three_pointers_made: 10,
      field_goals_made: 30,
      field_goals_attempted: 40,
      free_throws_made: 20,
      free_throws_attempted: 20,
      double_double: true,
      triple_double: true,
    },
    {
      player_id: awayBench.id,
      game_id: game.id,
      season_year: fixtureSeasonYear,
      week_number: weekNumber,
      game_date: gameDate,
      points: 90,
      rebounds: 18,
      assists: 18,
      steals: 8,
      blocks: 8,
      turnovers: 0,
      three_pointers_made: 9,
      field_goals_made: 28,
      field_goals_attempted: 35,
      free_throws_made: 18,
      free_throws_attempted: 18,
      double_double: true,
      triple_double: true,
    },
  ]

  const { error: statsError } = await supabase
    .from('player_game_stats')
    .insert([homeStarterStats, homeStarterSecondStats, awayStarterStats, ...benchStats])
  if (statsError) throw new Error(`${label}: player stats fixture insert failed: ${statsError.message}`)

  const { error: lineupError } = await supabase.from('weekly_lineups').insert([
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: homeMember.id,
      player_id: homeStarter.id,
      week_number: weekNumber,
      game_date: secondDate,
      slot_type: 'PG',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: homeMember.id,
      player_id: homeStarter.id,
      week_number: weekNumber,
      game_date: gameDate,
      slot_type: 'PG',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: homeMember.id,
      player_id: homeBench.id,
      week_number: weekNumber,
      game_date: gameDate,
      slot_type: 'BE',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: awayMember.id,
      player_id: awayStarter.id,
      week_number: weekNumber,
      game_date: gameDate,
      slot_type: 'SG',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: awayMember.id,
      player_id: awayBench.id,
      week_number: weekNumber,
      game_date: gameDate,
      slot_type: 'BE',
    },
  ])
  if (lineupError) throw new Error(`${label}: weekly lineup fixture insert failed: ${lineupError.message}`)

  const { data: matchup, error: matchupError } = await supabase
    .from('matchups')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: weekNumber,
      matchup_type: 'regular_season',
      home_member_id: homeMember.id,
      away_member_id: awayMember.id,
      is_finalized: false,
    })
    .select('id')
    .single()
  if (matchupError) throw new Error(`${label}: matchup fixture insert failed: ${matchupError.message}`)

  const standingsBefore = await countRows(supabase, 'standings', {
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    week_number: weekNumber,
  })
  await backendJson(env, '/e2e/sync-scores', { leagueId: fixture.league.id, date: scoringReferenceDate })
  const scheduledSyncMatchup = await readScoringMatchup(supabase, matchup.id, label)
  const expectedHomePoints = calculateFixturePoints(homeStarterStats, scoringSettings) + calculateFixturePoints(homeStarterSecondStats, scoringSettings)
  const expectedAwayPoints = calculateFixturePoints(awayStarterStats, scoringSettings)

  assertNumberEquals(failures, `${label}: scheduled-sync home_points`, scheduledSyncMatchup.home_points, expectedHomePoints)
  assertNumberEquals(failures, `${label}: scheduled-sync away_points`, scheduledSyncMatchup.away_points, expectedAwayPoints)
  if (scheduledSyncMatchup.is_finalized) {
    failures.push(`${label}: matchup finalized while an NBA game was still Scheduled`)
  }

  const { error: finalGameError } = await supabase
    .from('nba_games')
    .update({ status: 'Final', home_score: 120, away_score: 111, ended_at: new Date().toISOString() })
    .in('id', [game.id, secondGame.id])
  if (finalGameError) throw new Error(`${label}: final game update failed: ${finalGameError.message}`)

  await backendJson(env, '/e2e/sync-scores', { leagueId: fixture.league.id, date: scoringReferenceDate })
  const finalizedMatchup = await readScoringMatchup(supabase, matchup.id, label)
  const standingsAfter = await countRows(supabase, 'standings', {
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    week_number: weekNumber,
  })

  assertNumberEquals(failures, `${label}: finalized home_points`, finalizedMatchup.home_points, expectedHomePoints)
  assertNumberEquals(failures, `${label}: finalized away_points`, finalizedMatchup.away_points, expectedAwayPoints)
  if (!finalizedMatchup.is_finalized) {
    failures.push(`${label}: matchup did not finalize after all NBA games were Final`)
  }
  if (finalizedMatchup.winner_member_id !== homeMember.id) {
    failures.push(`${label}: winner_member_id=${finalizedMatchup.winner_member_id ?? '<null>'}; expected home starter winner ${homeMember.id}`)
  }
  if (finalizedMatchup.home_max_possible_points == null || finalizedMatchup.away_max_possible_points == null) {
    failures.push(`${label}: finalized matchup did not persist max_possible_points for both teams`)
  }
  if (standingsAfter <= standingsBefore) {
    failures.push(`${label}: finalizing week did not append standings rows (${standingsBefore} -> ${standingsAfter})`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    fixtureSeasonYear,
    weekNumber,
      gameDate,
      secondDate,
      gameId: game.id,
      secondGameId: secondGame.id,
    matchupId: matchup.id,
    members: {
      home: homeMember,
      away: awayMember,
    },
    players: {
      homeStarter,
      homeBench,
      awayStarter,
      awayBench,
    },
    expected: {
      homePoints: expectedHomePoints,
      awayPoints: expectedAwayPoints,
      winnerMemberId: homeMember.id,
      standingsRowsShouldIncrease: true,
      maxPossiblePointsShouldBePersisted: true,
    },
    scheduledSyncMatchup,
    finalizedMatchup,
    standingsBefore,
    standingsAfter,
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'weekly-scoring-finalization.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

export const resetFixtureSeasonYear = () => 9000 + Number(Date.now().toString().slice(-6))

export const assertSeasonResetScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SEA.6'
  const fixtureSeasonYear = resetFixtureSeasonYear()
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 4,
    seasonYear: fixtureSeasonYear,
  })
  const [member1, member2, member3, member4] = fixture.members

  const { data: players, error: playersError } = await seededPlayerQuery(supabase)
    .limit(4)
  if (playersError) throw new Error(`${label}: player lookup failed: ${playersError.message}`)
  if ((players ?? []).length < 4) throw new Error(`${label}: requires at least four players`)

  const pickRows = []
  for (const member of fixture.members) {
    for (let seasonYear = fixtureSeasonYear + 1; seasonYear <= fixtureSeasonYear + 5; seasonYear += 1) {
      for (let round = 1; round <= 3; round += 1) {
        pickRows.push({
          league_id: fixture.league.id,
          season_year: seasonYear,
          round,
          original_owner_id: member.id,
          current_owner_id: member.id,
        })
      }
    }
  }

  const standingsRows = [
    { member: member4, wins: 1, pointsFor: 800, pointsAgainst: 1100, waiverPriority: 4 },
    { member: member3, wins: 3, pointsFor: 900, pointsAgainst: 1050, waiverPriority: 3 },
    { member: member2, wins: 6, pointsFor: 1000, pointsAgainst: 1000, waiverPriority: 2 },
    { member: member1, wins: 9, pointsFor: 1100, pointsAgainst: 900, waiverPriority: 1 },
  ].map((row) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: row.member.id,
    week_number: 19,
    wins: row.wins,
    losses: 10 - row.wins,
    ties: 0,
    points_for: row.pointsFor,
    points_against: row.pointsAgainst,
    max_possible_points: row.pointsFor + 50,
    waiver_priority: row.waiverPriority,
  }))

  const rosterRows = [
    { member: member1, player: players[0], is_on_ir: false, is_on_taxi: false },
    { member: member2, player: players[1], is_on_ir: true, is_on_taxi: false },
    { member: member3, player: players[2], is_on_ir: false, is_on_taxi: true },
    { member: member4, player: players[3], is_on_ir: false, is_on_taxi: false },
  ].map((row) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: row.member.id,
    player_id: row.player.id,
    is_on_ir: row.is_on_ir,
    is_on_taxi: row.is_on_taxi,
    acquired_via: 'e2e_reset_fixture',
  }))

  const lineupRows = rosterRows.slice(0, 2).map((row) => ({
    league_id: row.league_id,
    league_season_id: row.league_season_id,
    member_id: row.member_id,
    player_id: row.player_id,
    week_number: 19,
    game_date: `${fixtureSeasonYear}-04-10`,
    slot_type: 'UTIL',
  }))

  const waiverRows = fixture.members.map((member, index) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: member.id,
    priority: fixture.members.length - index,
  }))

  const { error: weekError } = await supabase
    .from('season_weeks')
    .upsert({
      season_year: fixtureSeasonYear,
      week_number: 19,
      week_start: `${fixtureSeasonYear}-04-08`,
      week_end: `${fixtureSeasonYear}-04-14`,
    }, { onConflict: 'season_year,week_number' })
  if (weekError) throw new Error(`${label}: season week insert failed: ${weekError.message}`)

  const [{ error: picksError }, { error: standingsError }, { error: rosterError }, { error: lineupError }, { error: waiverError }] = await Promise.all([
    supabase.from('draft_picks').insert(pickRows),
    supabase.from('standings').insert(standingsRows),
    supabase.from('roster_players').insert(rosterRows),
    supabase.from('weekly_lineups').insert(lineupRows),
    supabase.from('waiver_priorities').insert(waiverRows),
  ])
  if (picksError) throw new Error(`${label}: draft pick insert failed: ${picksError.message}`)
  if (standingsError) throw new Error(`${label}: standings insert failed: ${standingsError.message}`)
  if (rosterError) throw new Error(`${label}: roster insert failed: ${rosterError.message}`)
  if (lineupError) throw new Error(`${label}: lineup insert failed: ${lineupError.message}`)
  if (waiverError) throw new Error(`${label}: waiver priority insert failed: ${waiverError.message}`)

  const { data: matchup, error: matchupError } = await supabase
    .from('matchups')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 19,
      matchup_type: 'regular_season',
      home_member_id: member1.id,
      away_member_id: member2.id,
      home_points: 111,
      away_points: 99,
      winner_member_id: member1.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (matchupError || !matchup) throw new Error(`${label}: historical matchup insert failed: ${matchupError?.message ?? 'missing row'}`)

  const { error: statusError } = await supabase
    .from('leagues')
    .update({ status: 'playoffs' })
    .eq('id', fixture.league.id)
  if (statusError) throw new Error(`${label}: playoff status staging failed: ${statusError.message}`)

  const resetResult = await backendJson(env, '/e2e/advance-season', { leagueId: fixture.league.id })
  const newSeasonId = resetResult.newSeasonId
  const newYear = resetResult.newYear
  if (!newSeasonId || newYear !== fixtureSeasonYear + 1) {
    failures.push(`${label}: reset returned ${JSON.stringify(resetResult)}; expected newYear ${fixtureSeasonYear + 1}`)
  }

  const [
    seasons,
    newRoster,
    newWaivers,
    horizonPicks,
    oldStandings,
    oldLineups,
    oldMatchup,
    league,
  ] = await Promise.all([
    fetchAll(supabase, 'league_seasons', 'id, season_year, is_current', { league_id: fixture.league.id }),
    fetchAll(supabase, 'roster_players', 'member_id, player_id, is_on_ir, is_on_taxi, acquired_via', {
      league_id: fixture.league.id,
      league_season_id: newSeasonId,
    }),
    fetchAll(supabase, 'waiver_priorities', 'member_id, priority', {
      league_id: fixture.league.id,
      league_season_id: newSeasonId,
    }),
    fetchAll(supabase, 'draft_picks', 'season_year, round, original_owner_id, current_owner_id', { league_id: fixture.league.id }),
    fetchAll(supabase, 'standings', 'id, member_id, week_number', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'weekly_lineups', 'id, member_id, player_id, week_number', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchSingle(supabase, 'matchups', 'id, winner_member_id, is_finalized', { id: matchup.id }),
    fetchSingle(supabase, 'leagues', 'id, status', { id: fixture.league.id }),
  ])

  const currentSeasons = seasons.filter((row) => row.is_current)
  if (currentSeasons.length !== 1 || currentSeasons[0]?.id !== newSeasonId) {
    failures.push(`${label}: current seasons after reset ${JSON.stringify(currentSeasons)}; expected exactly ${newSeasonId}`)
  }
  const oldSeason = seasons.find((row) => row.id === fixture.leagueSeason.id)
  if (oldSeason?.is_current !== false) {
    failures.push(`${label}: old season ${fixture.leagueSeason.id} is_current=${oldSeason?.is_current}; expected false`)
  }
  if (league.status !== 'offseason') {
    failures.push(`${label}: league status ${league.status}; expected offseason after reset`)
  }

  const expectedRosterKeys = new Set(rosterRows.map((row) => `${row.member_id}:${row.player_id}:${row.is_on_ir}:${row.is_on_taxi}`))
  const actualRosterKeys = new Set(newRoster.map((row) => `${row.member_id}:${row.player_id}:${row.is_on_ir}:${row.is_on_taxi}`))
  for (const key of expectedRosterKeys) {
    if (!actualRosterKeys.has(key)) failures.push(`${label}: carried roster missing ${key}`)
  }
  if (newRoster.some((row) => row.acquired_via !== 'carry_over')) {
    failures.push(`${label}: one or more carried roster rows did not stamp acquired_via=carry_over`)
  }

  const expectedPriority = new Map([
    [member4.id, 1],
    [member3.id, 2],
    [member2.id, 3],
    [member1.id, 4],
  ])
  for (const [memberId, priority] of expectedPriority) {
    const row = newWaivers.find((candidate) => candidate.member_id === memberId)
    if (row?.priority !== priority) {
      failures.push(`${label}: waiver priority for ${memberId} is ${row?.priority ?? '<missing>'}; expected ${priority}`)
    }
  }

  const pickKeys = new Set(horizonPicks.map((pick) => `${pick.season_year}:${pick.round}:${pick.original_owner_id}:${pick.current_owner_id}`))
  for (let seasonYear = newYear + 1; seasonYear <= newYear + 5; seasonYear += 1) {
    for (let round = 1; round <= 3; round += 1) {
      for (const member of fixture.members) {
        const key = `${seasonYear}:${round}:${member.id}:${member.id}`
        if (!pickKeys.has(key)) failures.push(`${label}: missing reset horizon pick ${key}`)
      }
    }
  }

  if (oldStandings.length !== standingsRows.length) {
    failures.push(`${label}: old standings rows query returned ${oldStandings.length}; expected ${standingsRows.length}`)
  }
  if (oldLineups.length !== lineupRows.length) {
    failures.push(`${label}: old weekly_lineups rows query returned ${oldLineups.length}; expected ${lineupRows.length}`)
  }
  if (oldMatchup.id !== matchup.id || !oldMatchup.is_finalized || oldMatchup.winner_member_id !== member1.id) {
    failures.push(`${label}: old matchup history was not retained correctly`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    oldSeasonId: fixture.leagueSeason.id,
    fixtureSeasonYear,
    resetResult,
    seasons,
    carriedRoster: newRoster,
    waiverPriorities: newWaivers,
    oldHistory: {
      standingsRows: oldStandings.length,
      lineupRows: oldLineups.length,
      matchup: oldMatchup,
    },
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'season-reset.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

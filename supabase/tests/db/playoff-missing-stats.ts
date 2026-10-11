import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')
assert.ok(
  api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname),
  'Only an isolated local backend is allowed',
)
const token = crypto.randomUUID().replaceAll('-', '')
let pendingProviderReads = 0
let providerPhase = 'unavailable'
let recoveryPlayers: any[] = []
const provider = Deno.serve(
  { hostname: '127.0.0.1', port: 0, onListen() {} },
  (request) => {
    assert.equal(
      new URL(request.url).pathname,
      `/liveData/boxscore/boxscore_002-span-${token}-0.json`,
    )
    pendingProviderReads++
    return Response.json({
      game: {
        gameId: `002-span-${token}-0`,
        gameStatus: providerPhase === 'unavailable' ? 1 : 3,
        homeTeam: {
          players: ['recovered', 'partial-final'].includes(providerPhase)
            ? recoveryPlayers.slice(0, 4).map((p) =>
              providerPhase === 'partial-final' ? { ...p, statistics: {} } : p
            )
            : [],
        },
        awayTeam: {
          players: ['recovered', 'partial-final'].includes(providerPhase)
            ? recoveryPlayers.slice(4).map((p) =>
              providerPhase === 'partial-final' ? { ...p, statistics: {} } : p
            )
            : [],
        },
      },
    })
  },
)
const providerOrigin = `http://127.0.0.1:${provider.addr.port}`
const priorProvider = Deno.env.get('NBA_CDN_BASE_URL')
Deno.env.set('NBA_CDN_BASE_URL', providerOrigin)
let scopeScoreSeasons: string[] = []
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  )
  assert.ok(
    [api, providerOrigin].includes(url.origin),
    'No external services may be contacted',
  )
  if (
    scopeScoreSeasons.length && url.pathname === '/rest/v1/league_seasons' &&
    url.searchParams.get('select')?.includes('scoring_settings')
  ) {
    url.searchParams.set('id', `in.(${scopeScoreSeasons.join(',')})`)
    return nativeFetch(
      input instanceof Request ? new Request(url, input) : url,
      init,
    )
  }
  return nativeFetch(input, init)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { runSeasonBoundary } = await import(
  '../../functions/_shared/seasonBoundary.ts'
)
const query = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const league = crypto.randomUUID(), season = crypto.randomUUID()
const members = Array.from({ length: 4 }, () => crypto.randomUUID())
const players = Array.from({ length: 8 }, () => crypto.randomUUID())
const games = Array.from({ length: 5 }, () => crypto.randomUUID())
const weekIds = Array.from({ length: 8 }, () => crypto.randomUUID())
const healthyLeague = crypto.randomUUID(),
  healthySeason = crypto.randomUUID(),
  healthyGame = crypto.randomUUID()
const healthyMembers = [crypto.randomUUID(), crypto.randomUUID()],
  healthyWeeks = Array.from({ length: 8 }, () => crypto.randomUUID())
const users: string[] = []
const today = new Date().toLocaleDateString('en-CA', {
  timeZone: 'America/New_York',
})
const addDays = (day: string, count: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString()
    .slice(0, 10)
const first = addDays(today, -70)
const dateForWeek = (week: number) => addDays(first, (week - 1) * 7 + 2)
let year = 0
let insertedWeeks = false
let reachedAssertions = false
const checks: string[] = []
const check = (ok: boolean, label: string) => {
  assert.ok(ok, label)
  checks.push(label)
}
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = 3000 +
      crypto.getRandomValues(new Uint32Array(1))[0] % 5000
    const rows = await query(
      supabase.from('season_weeks').select('id').in('season_year', [
        candidate,
        candidate + 1,
      ]),
    )
    const seasons = await query(
      supabase.from('league_seasons').select('id').in('season_year', [
        candidate,
        candidate + 1,
      ]),
    )
    const existingGames = await query(
      supabase.from('nba_games').select('id').in('season_year', [
        candidate,
        candidate + 1,
      ]),
    )
    if (!rows.length && !seasons.length && !existingGames.length) {
      year = candidate
      break
    }
  }
  assert.ok(year)
  for (let side = 0; side < 4; side++) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `playoff-span-${token}-${side}@example.test`,
      password: `Synthetic-${crypto.randomUUID()}!`,
      email_confirm: true,
      user_metadata: {
        username: `span_${token.slice(0, 15)}_${side}`,
        display_name: 'Synthetic playoff span',
      },
    })
    if (error) throw new Error(error.message)
    assert.ok(data.user)
    users.push(data.user.id)
  }
  await query(
    supabase.from('leagues').insert({
      id: league,
      slug: `span-${token}`,
      name: 'Synthetic multi-week playoffs',
      commissioner_id: users[0],
      status: 'active',
      scoring_settings: { points: 1, assists: 0.1 },
      playoff_start_week: 1,
      playoff_total_weeks: 5,
      playoff_round_weeks: [2, 3],
    }),
  )
  await query(
    supabase.from('league_members').insert(
      members.map((id, side) => ({
        id,
        league_id: league,
        user_id: users[side],
        role: side ? 'manager' as const : 'commissioner' as const,
        team_name: `Span side ${side}`,
      })),
    ),
  )
  await query(
    supabase.from('league_seasons').insert({
      id: season,
      league_id: league,
      season_year: year,
      is_current: true,
    }),
  )
  await query(
    supabase.from('season_weeks').insert(
      weekIds.map((id, index) => ({
        id,
        season_year: year,
        week_number: index + 1,
        week_start: addDays(first, index * 7),
        week_end: addDays(first, index * 7 + 6),
      })),
    ),
  )
  insertedWeeks = true
  await query(
    supabase.from('players').insert(
      players.map((id, index) => ({
        id,
        first_name: 'Synthetic',
        last_name: `Span ${token}-${index}`,
        position: 'PG' as const,
        eligible_positions: ['PG'],
        nba_team: 'XSP',
        years_exp: 2,
      })),
    ),
  )
  await query(
    supabase.from('roster_players').insert(
      players.map((id, index) => ({
        player_id: id,
        member_id: members[Math.floor(index / 2)],
        league_id: league,
        league_season_id: season,
        acquired_via: 'draft',
        acquired_at: `${addDays(first, -7)}T12:00:00Z`,
      })),
    ),
  )
  await query(
    supabase.from('nba_games').insert(
      games.map((id, index) => ({
        id,
        nba_game_id: `002-span-${token}-${index}`,
        season_year: year,
        week_number: index + 1,
        game_date: dateForWeek(index + 1),
        game_time: `${dateForWeek(index + 1)}T19:00:00Z`,
        home_team: 'XSP',
        away_team: 'XSQ',
        status: 'Final',
        stats_synced_at: new Date().toISOString(),
      })),
    ),
  )
  await query(supabase.from('weekly_lineups').delete().eq('league_id', league))
  // Actual boundary code handles start1 instead of repeatedly creating an empty schedule.
  const started = await runSeasonBoundary(new Date(), league)
  check(
    started[0]?.actions.includes('bracket-generated') === true,
    'start1 boundary generates a real bracket',
  )
  const semis = await query(
    supabase.from('matchups').select('*').eq('league_season_id', season).eq(
      'matchup_type',
      'playoff_semifinal',
    ).order('id'),
  )
  check(
    semis.length === 2 &&
      semis.every((row: any) =>
        row.week_number === 1 && row.end_week_number === 2
      ),
    'semifinals span weeks1and2',
  )
  const homeMembers = new Set(semis.map((row: any) => row.home_member_id))
  const rows = []
  const lineupRows = []
  for (let week = 1; week <= 2; week++) {
    for (let index = 0; index < players.length; index++) {
      const member = members[Math.floor(index / 2)]
      const home = homeMembers.has(member)
      const bench = index % 2 === 1
      const points = bench
        ? (home ? 25 : 0)
        : home
        ? (week === 1 ? 10 : 30)
        : (week === 1 ? 20 : 10)
      rows.push({
        player_id: players[index],
        game_id: games[week - 1],
        season_year: year,
        week_number: week,
        game_date: dateForWeek(week),
        points,
        did_not_play: false,
      })
      lineupRows.push({
        player_id: players[index],
        member_id: member,
        league_id: league,
        league_season_id: season,
        week_number: week,
        game_date: dateForWeek(week),
        slot_type: bench ? 'BE' as const : 'PG' as const,
        is_auto_set: false,
      })
    }
  }
  await query(supabase.from('player_game_stats').insert(rows))
  await query(supabase.from('weekly_lineups').insert(lineupRows))
  const readSemis = () =>
    query(
      supabase.from('matchups').select('*').eq('league_season_id', season).eq(
        'matchup_type',
        'playoff_semifinal',
      ).order('id'),
    )
  for (let index = 0; index < players.length; index++) {
    const member = members[Math.floor(index / 2)],
      home = homeMembers.has(member),
      bench = index % 2 === 1
    const firstPoints = bench ? 0 : home ? 100 : 0,
      secondPoints = bench ? 0 : home ? 20 : 60
    await query(
      supabase.from('player_game_stats').update({ points: secondPoints }).eq(
        'game_id',
        games[1],
      ).eq('player_id', players[index]),
    )
    recoveryPlayers.push({
      personId: 700000000 + Number.parseInt(token.slice(0, 5), 16) * 10 + index,
      name: `Synthetic Span ${token}-${index}`,
      played: '1',
      statistics: {
        minutes: 'PT30M00.00S',
        points: firstPoints,
        reboundsTotal: 0,
        assists: 0,
        blocks: 0,
        fieldGoalsAttempted: 0,
        fieldGoalsMade: 0,
        foulsPersonal: 0,
        freeThrowsAttempted: 0,
        freeThrowsMade: 0,
        plusMinusPoints: 0,
        reboundsDefensive: 0,
        reboundsOffensive: 0,
        steals: 0,
        threePointersAttempted: 0,
        threePointersMade: 0,
        turnovers: 0,
      },
    })
  }
  await query(
    supabase.from('player_game_stats').delete().eq('game_id', games[0]),
  )
  await query(
    supabase.from('nba_games').update({ stats_synced_at: null }).eq(
      'id',
      games[0],
    ),
  )
  await assert.rejects(() => syncScores(league), /Stats recovery failed/)
  const missing = await readSemis()
  console.log(JSON.stringify({
    scenario: 'older-missing-boxscore',
    providerReads: pendingProviderReads,
    results: missing.map((m: any) => ({
      home: m.home_points,
      away: m.away_points,
      finalized: m.is_finalized,
      wrongWinner: m.winner_member_id === m.away_member_id,
    })),
  }))
  check(
    missing.every((m: any) => !m.is_finalized && m.winner_member_id == null),
    'missing older stats cannot select a winner',
  )
  check(
    pendingProviderReads > 0,
    'older Final game with no successful stats sync is retried',
  )
  await query(
    supabase.from('leagues').insert({
      id: healthyLeague,
      slug: `healthy-${token}`,
      name: 'Synthetic independent healthy season',
      commissioner_id: users[0],
      status: 'active',
      scoring_settings: { points: 1 },
      playoff_start_week: 9,
    }),
  )
  await query(
    supabase.from('league_members').insert(
      healthyMembers.map((id, i) => ({
        id,
        league_id: healthyLeague,
        user_id: users[i],
        role: i ? 'manager' as const : 'commissioner' as const,
        team_name: `Healthy ${i}`,
      })),
    ),
  )
  await query(
    supabase.from('league_seasons').insert({
      id: healthySeason,
      league_id: healthyLeague,
      season_year: year + 1,
      is_current: true,
    }),
  )
  await query(
    supabase.from('season_weeks').insert(
      healthyWeeks.map((id, i) => ({
        id,
        season_year: year + 1,
        week_number: i + 1,
        week_start: addDays(first, i * 7),
        week_end: addDays(first, i * 7 + 6),
      })),
    ),
  )
  await query(
    supabase.from('nba_games').insert({
      id: healthyGame,
      nba_game_id: `002-healthy-${token}`,
      season_year: year + 1,
      week_number: 1,
      game_date: dateForWeek(1),
      home_team: 'XHP',
      away_team: 'XHQ',
      status: 'Final',
      stats_synced_at: new Date().toISOString(),
    }),
  )
  await query(
    supabase.from('matchups').insert({
      league_id: healthyLeague,
      league_season_id: healthySeason,
      week_number: 1,
      home_member_id: healthyMembers[0],
      away_member_id: healthyMembers[1],
      matchup_type: 'regular_season',
    }),
  )
  await query(
    supabase.from('roster_players').insert(
      healthyMembers.map((m, i) => ({
        league_id: healthyLeague,
        league_season_id: healthySeason,
        member_id: m,
        player_id: players[i * 2],
        acquired_via: 'draft',
        acquired_at: `${addDays(first, -7)}T12:00:00Z`,
      })),
    ),
  )
  await query(
    supabase.from('weekly_lineups').insert(
      healthyMembers.map((m, i) => ({
        league_id: healthyLeague,
        league_season_id: healthySeason,
        member_id: m,
        player_id: players[i * 2],
        week_number: 1,
        game_date: dateForWeek(1),
        slot_type: 'PG' as const,
      })),
    ),
  )
  await query(
    supabase.from('player_game_stats').insert(
      healthyMembers.map((_m, i) => ({
        player_id: players[i * 2],
        game_id: healthyGame,
        season_year: year + 1,
        week_number: 1,
        game_date: dateForWeek(1),
        points: i ? 3 : 11,
        did_not_play: false,
      })),
    ),
  )
  providerPhase = 'empty-final'
  let rejected = false
  try {
    scopeScoreSeasons = [season, healthySeason]
    await syncScores()
  } catch (error) {
    rejected = true
    console.log('Empty Final provider rejected:', String(error))
  }
  scopeScoreSeasons = []
  const healthy = await query(
    supabase.from('matchups').select(
      'home_points,away_points,is_finalized,winner_member_id',
    ).eq('league_season_id', healthySeason).single(),
  )
  console.log(
    JSON.stringify({
      scenario: 'bad-recovery-independent-league',
      rejected,
      healthy,
      fixtureScope:
        'actual season scan limited to two new synthetic season IDs; DB responses unmodified',
    }),
  )
  check(
    healthy.is_finalized && Number(healthy.home_points) === 11 &&
      Number(healthy.away_points) === 3,
    'unrelated healthy season must score despite another recovery failure',
  )
  check(rejected, 'empty Final box score is rejected')
  const emptyGame = await query(
    supabase.from('nba_games').select('stats_synced_at').eq('id', games[0])
      .single(),
  )
  check(
    emptyGame.stats_synced_at == null,
    'empty Final does not mark stats complete',
  )
  providerPhase = 'recovered'
  await syncScores(league)
  const recovered = await readSemis()
  check(
    recovered.every((m: any) =>
      Number(m.home_points) === 120 && Number(m.away_points) === 60 &&
      m.is_finalized && m.winner_member_id === m.home_member_id
    ),
    'actual provider recovery restores full span and correct seeded-home winners',
  )
  const restored = await query(
    supabase.from('player_game_stats').select('player_id').eq(
      'game_id',
      games[0],
    ),
  )
  check(
    restored.length === 8,
    'all eight synthetic provider stat lines persist',
  )
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
  const storedGame = await query(
    supabase.from('nba_games').select('*').eq('id', games[0]).single(),
  )
  const priorStats = await query(
    supabase.from('player_game_stats').select('player_id,points').eq(
      'game_id',
      games[0],
    ).order('player_id'),
  )
  providerPhase = 'partial-final'
  let partialError: string | null = null
  try {
    await syncStatsGame(storedGame)
  } catch (e) {
    partialError = String(e)
  }
  const partialStats = await query(
    supabase.from('player_game_stats').select('player_id,points').eq(
      'game_id',
      games[0],
    ).order('player_id'),
  )
  console.log(
    JSON.stringify({
      scenario: 'partial-Final-real-db',
      partialError,
      before: priorStats,
      after: partialStats,
    }),
  )
  check(
    partialError !== null &&
      JSON.stringify(partialStats) === JSON.stringify(priorStats),
    'partial Final must reject before overwriting complete stats',
  )
  await query(
    supabase.from('nba_games').update({
      nba_game_id: `${token}-BBRef`,
      stats_synced_at: null,
    }).eq('id', games[0]),
  )
  await query(
    supabase.from('matchups').update({
      is_finalized: false,
      winner_member_id: null,
      finalized_at: null,
    }).eq('league_season_id', season).eq('matchup_type', 'playoff_semifinal'),
  )
  await syncScores(league)
  const bbref = await readSemis()
  console.log(
    JSON.stringify({
      scenario: 'BBRef-null-marker-guard',
      results: bbref.map((m: any) => ({
        finalized: m.is_finalized,
        home: m.home_points,
        away: m.away_points,
      })),
    }),
  )
  check(
    bbref.every((m: any) => m.is_finalized),
    'non-CDN Final marker does not block finalization',
  )
  reachedAssertions = true
  console.log(
    JSON.stringify({
      scenario: 'real-missing-playoff-stats',
      checks: checks.length,
      passed: checks,
      fixtureLimit:
        'historical synthetic dates and a local synthetic provider; no real NBA data',
    }),
  )
} finally {
  const errors: string[] = []
  const clean = async (label: string, action: () => Promise<any>) => {
    try {
      await action()
    } catch (error) {
      errors.push(`${label}: ${(error as Error).message}`)
    }
  }
  scopeScoreSeasons = []
  await clean(
    'healthy league',
    () => query(supabase.from('leagues').delete().eq('id', healthyLeague)),
  )
  await clean(
    'healthy stats',
    () =>
      query(
        supabase.from('player_game_stats').delete().eq('game_id', healthyGame),
      ),
  )
  await clean(
    'healthy game',
    () => query(supabase.from('nba_games').delete().eq('id', healthyGame)),
  )
  await clean(
    'healthy weeks',
    () => query(supabase.from('season_weeks').delete().in('id', healthyWeeks)),
  )
  await clean(
    'league',
    () => query(supabase.from('leagues').delete().eq('id', league)),
  )
  await clean(
    'stats',
    () =>
      query(supabase.from('player_game_stats').delete().in('game_id', games)),
  )
  await clean(
    'games',
    () => query(supabase.from('nba_games').delete().in('id', games)),
  )
  await clean(
    'players',
    () => query(supabase.from('players').delete().in('id', players)),
  )
  if (insertedWeeks) {
    await clean(
      'weeks',
      () => query(supabase.from('season_weeks').delete().in('id', weekIds)),
    )
  }
  for (const user of users) {
    await clean('user', async () => {
      const { error } = await supabase.auth.admin.deleteUser(user)
      if (error) throw new Error(error.message)
    })
  }
  globalThis.fetch = nativeFetch
  if (priorProvider === undefined) Deno.env.delete('NBA_CDN_BASE_URL')
  else Deno.env.set('NBA_CDN_BASE_URL', priorProvider)
  await provider.shutdown()
  console.log(
    JSON.stringify({
      scenario: 'real-missing-playoff-stats',
      cleanupErrors: errors,
      reachedAssertions,
    }),
  )
  if (errors.length) throw new Error(errors.join('; '))
}

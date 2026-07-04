// Deterministic battery for the round-robin matchup engine.
// Seed is recorded so every run exercises the identical team orderings.
const SEED = 20260703

type Pairing = { home: string; away: string }

type MockSeason = {
  id: string
  league_id: string
  leagues: { playoff_start_week: number | null } | null
}

const membersByLeague: Record<string, { id: string }[]> = {}
let seasons: MockSeason[] = []
const rpcCalls: { name: string; body: Record<string, unknown> }[] = []

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url)

  let body: unknown = []
  if (url.pathname === '/rest/v1/league_members') {
    const leagueId = url.searchParams.get('league_id')?.replace(/^eq\./, '') ?? ''
    body = membersByLeague[leagueId] ?? []
  } else if (url.pathname === '/rest/v1/league_seasons') {
    const leagueId = url.searchParams.get('league_id')?.replace(/^eq\./, '')
    body = leagueId ? seasons.filter((season) => season.league_id === leagueId) : seasons
  } else if (url.pathname.startsWith('/rest/v1/rpc/')) {
    rpcCalls.push({
      name: url.pathname.slice('/rest/v1/rpc/'.length),
      body: await req.json() as Record<string, unknown>,
    })
    body = null
  }

  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')

const { roundRobinRounds, generateMatchups, generateAllMatchups } = await import('./matchups.ts')

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: T[], rng: () => number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// Invariant checker shared by the real implementation and the mutation proof:
// returns a list of violations so tests can assert "no violations" or
// "the checker has teeth" symmetrically.
function roundRobinViolations(ids: string[], rounds: Pairing[][]): string[] {
  const n = ids.length
  const violations: string[] = []
  const expectedRounds = n % 2 === 0 ? n - 1 : n
  if (rounds.length !== expectedRounds) {
    violations.push(`expected ${expectedRounds} rounds per cycle, got ${rounds.length}`)
  }

  const idSet = new Set(ids)
  const pairCounts = new Map<string, number>()
  const expectedGamesPerRound = Math.floor(n / 2)

  rounds.forEach((round, roundIndex) => {
    if (round.length !== expectedGamesPerRound) {
      violations.push(`round ${roundIndex}: expected ${expectedGamesPerRound} games, got ${round.length}`)
    }
    const seen = new Set<string>()
    for (const { home, away } of round) {
      if (home === '__bye__' || away === '__bye__') {
        violations.push(`round ${roundIndex}: '__bye__' persisted in ${home} vs ${away}`)
      }
      if (home === away) violations.push(`round ${roundIndex}: self-pairing ${home}`)
      if (!idSet.has(home) || !idSet.has(away)) {
        violations.push(`round ${roundIndex}: unknown team in ${home} vs ${away}`)
      }
      if (seen.has(home)) violations.push(`round ${roundIndex}: ${home} scheduled twice`)
      if (seen.has(away)) violations.push(`round ${roundIndex}: ${away} scheduled twice`)
      seen.add(home)
      seen.add(away)
      const key = [home, away].sort().join('|')
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
    }
  })

  let totalPairings = 0
  for (const round of rounds) totalPairings += round.length
  if (totalPairings !== (n * (n - 1)) / 2) {
    violations.push(`expected ${(n * (n - 1)) / 2} pairings per cycle, got ${totalPairings}`)
  }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const key = [ids[i], ids[j]].sort().join('|')
      const count = pairCounts.get(key) ?? 0
      if (count !== 1) violations.push(`pair ${key} meets ${count} times per cycle`)
    }
  }

  return violations
}

// Deliberately broken variant: rotates the whole circle instead of holding the
// first team fixed, a classic round-robin off-by-one that repeats some pairs
// and never schedules others. Lives only in this test to prove the invariant
// checker rejects broken schedules.
function brokenRoundRobinRounds(ids: string[]): Pairing[][] {
  const teams = ids.length % 2 === 0 ? [...ids] : [...ids, '__bye__']
  const n = teams.length
  const rounds: Pairing[][] = []
  for (let r = 0; r < n - 1; r += 1) {
    const circle = [...teams.slice(r), ...teams.slice(0, r)]
    const pairings: Pairing[] = []
    for (let i = 0; i < n / 2; i += 1) {
      const home = circle[i]
      const away = circle[n - 1 - i]
      if (home !== '__bye__' && away !== '__bye__') pairings.push({ home, away })
    }
    rounds.push(pairings)
  }
  return rounds
}

Deno.test({
  name: `roundRobinRounds satisfies schedule invariants for N=2..14 (seed ${SEED})`,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => {
    const rng = mulberry32(SEED)
    for (let n = 2; n <= 14; n += 1) {
      const ids = shuffled(
        Array.from({ length: n }, (_, i) => `team-${String(i + 1).padStart(2, '0')}`),
        rng,
      )
      const violations = roundRobinViolations(ids, roundRobinRounds(ids))
      if (violations.length > 0) {
        throw new Error(`N=${n} (ids ${ids.join(',')}): ${violations.join('; ')}`)
      }
    }
  },
})

Deno.test({
  name: 'mutation proof: whole-circle rotation off-by-one is rejected by the invariant checker',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => {
    const rng = mulberry32(SEED)
    let rejectedCounts = 0
    for (let n = 4; n <= 14; n += 1) {
      const ids = shuffled(
        Array.from({ length: n }, (_, i) => `team-${String(i + 1).padStart(2, '0')}`),
        rng,
      )
      const violations = roundRobinViolations(ids, brokenRoundRobinRounds(ids))
      if (violations.length > 0) rejectedCounts += 1
    }
    assert(rejectedCounts === 11, `expected the checker to reject the broken schedule for every N=4..14, rejected ${rejectedCounts}/11`)

    const sampleViolations = roundRobinViolations(
      ['team-01', 'team-02', 'team-03', 'team-04'],
      brokenRoundRobinRounds(['team-01', 'team-02', 'team-03', 'team-04']),
    )
    assert(
      sampleViolations.some((violation) => violation.includes('meets')),
      `expected a pair-frequency violation, got: ${sampleViolations.join('; ')}`,
    )
  },
})

Deno.test({
  name: 'generateMatchups maps weeks onto round-robin cycles with stable home/away and persists no byes',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const memberIds = ['m1', 'm2', 'm3', 'm4']
    membersByLeague['league-even'] = memberIds.map((id) => ({ id }))
    rpcCalls.length = 0

    await generateMatchups('league-even', 'season-even', 9)

    assert(rpcCalls.length === 1, `expected 1 rpc call, got ${rpcCalls.length}`)
    const call = rpcCalls[0]
    assert(call.name === 'replace_regular_season_matchups_atomic', `unexpected rpc ${call.name}`)
    assert(call.body.p_league_id === 'league-even', 'wrong p_league_id')
    assert(call.body.p_league_season_id === 'season-even', 'wrong p_league_season_id')
    assert(call.body.p_force === false, 'p_force must default to false')

    const rows = call.body.p_matchups as {
      week_number: number
      home_member_id: string
      away_member_id: string
      matchup_type: string
    }[]
    const rounds = roundRobinRounds(memberIds)
    assert(rounds.length === 3, `expected 3 rounds for 4 teams, got ${rounds.length}`)
    assert(rows.length === 9 * 2, `expected 18 rows, got ${rows.length}`)
    assert(rows.every((row) => row.matchup_type === 'regular_season'), 'all rows must be regular_season')

    for (let week = 1; week <= 9; week += 1) {
      const weekPairs = rows
        .filter((row) => row.week_number === week)
        .map((row) => ({ home: row.home_member_id, away: row.away_member_id }))
      // Contract: week w replays rounds[(w-1) % rounds.length] verbatim across
      // cycles — pairings and home/away sides do NOT alternate between cycles.
      const expected = rounds[(week - 1) % rounds.length]
      assert(
        JSON.stringify(weekPairs) === JSON.stringify(expected),
        `week ${week}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(weekPairs)}`,
      )
    }
  },
})

Deno.test({
  name: 'generateMatchups wraps odd team counts across cycles without byes or double-scheduling',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const memberIds = ['m1', 'm2', 'm3', 'm4', 'm5']
    membersByLeague['league-odd'] = memberIds.map((id) => ({ id }))
    rpcCalls.length = 0

    await generateMatchups('league-odd', 'season-odd', 19, true)

    assert(rpcCalls.length === 1, `expected 1 rpc call, got ${rpcCalls.length}`)
    const call = rpcCalls[0]
    assert(call.body.p_force === true, 'p_force must pass through')

    const rows = call.body.p_matchups as {
      week_number: number
      home_member_id: string
      away_member_id: string
    }[]
    // 5 teams -> 5 rounds of 2 games (one team byes each week, never persisted).
    assert(rows.length === 19 * 2, `expected 38 rows, got ${rows.length}`)
    assert(
      rows.every((row) => row.home_member_id !== '__bye__' && row.away_member_id !== '__bye__'),
      "'__bye__' leaked into a persisted pairing",
    )

    for (let week = 1; week <= 19; week += 1) {
      const weekRows = rows.filter((row) => row.week_number === week)
      assert(weekRows.length === 2, `week ${week}: expected 2 games, got ${weekRows.length}`)
      const seen = new Set<string>()
      for (const row of weekRows) {
        assert(row.home_member_id !== row.away_member_id, `week ${week}: self-pairing`)
        assert(!seen.has(row.home_member_id) && !seen.has(row.away_member_id), `week ${week}: team plays twice`)
        seen.add(row.home_member_id)
        seen.add(row.away_member_id)
      }
    }

    // Cycle wrap: week 6 must replay week 1 (5 rounds per cycle for 5 teams).
    const pairsForWeek = (week: number) =>
      JSON.stringify(rows.filter((row) => row.week_number === week).map((row) => [row.home_member_id, row.away_member_id]))
    assert(pairsForWeek(6) === pairsForWeek(1), 'week 6 must wrap around to round 1 of the cycle')
    assert(pairsForWeek(11) === pairsForWeek(1), 'week 11 must wrap around to round 1 of the cycle')
  },
})

Deno.test({
  name: 'generateMatchups is a no-op for leagues with fewer than 2 members',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    membersByLeague['league-solo'] = [{ id: 'm1' }]
    rpcCalls.length = 0

    await generateMatchups('league-solo', 'season-solo', 19)

    assert(rpcCalls.length === 0, `expected no rpc calls, got ${rpcCalls.length}`)
  },
})

Deno.test({
  name: 'generateAllMatchups schedules through playoff_start_week - 1 per league (default 20)',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    membersByLeague['league-a'] = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }]
    membersByLeague['league-b'] = [{ id: 'b1' }, { id: 'b2' }]
    seasons = [
      { id: 'season-a', league_id: 'league-a', leagues: { playoff_start_week: 15 } },
      { id: 'season-b', league_id: 'league-b', leagues: null },
    ]
    rpcCalls.length = 0

    await generateAllMatchups(true)

    assert(rpcCalls.length === 2, `expected 2 rpc calls, got ${rpcCalls.length}`)
    const byLeague = new Map(rpcCalls.map((call) => [call.body.p_league_id as string, call.body]))

    const leagueA = byLeague.get('league-a')
    assert(leagueA !== undefined, 'missing rpc call for league-a')
    assert(leagueA!.p_league_season_id === 'season-a', 'league-a wired to wrong season')
    assert(leagueA!.p_force === true, 'force flag must propagate')
    const weeksA = (leagueA!.p_matchups as { week_number: number }[]).map((row) => row.week_number)
    assert(Math.max(...weeksA) === 14, `league-a: expected last regular week 14, got ${Math.max(...weeksA)}`)
    assert(Math.min(...weeksA) === 1, 'league-a: schedule must start at week 1')

    const leagueB = byLeague.get('league-b')
    assert(leagueB !== undefined, 'missing rpc call for league-b')
    const weeksB = (leagueB!.p_matchups as { week_number: number }[]).map((row) => row.week_number)
    assert(Math.max(...weeksB) === 19, `league-b: default playoff week 20 implies last regular week 19, got ${Math.max(...weeksB)}`)
    assert(weeksB.length === 19, `league-b: 2 teams play 1 game per week, expected 19 rows, got ${weeksB.length}`)
  },
})

Deno.test({
  name: 'close matchups test server',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => postgrest.shutdown(),
})

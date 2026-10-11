// A large dynasty league's week close reads stats for every rostered player. PostgREST
// refuses request lines over about 16 KB (431, empty body), so the read must be batched.

const MEMBER_A = '00000000-0000-4000-8000-00000000000a'
const MEMBER_B = '00000000-0000-4000-8000-00000000000b'
const GAME_DATE = '2101-01-03'
const playerId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// 300 + 151 players: one in-list of all of them is longer than PostgREST accepts.
const owners = new Map<string, string>()
for (let n = 1; n <= 451; n += 1) owners.set(playerId(n), n <= 300 ? MEMBER_A : MEMBER_B)

const statListSizes: number[] = []
const statPlayers = new Set<string>()

const inList = (url: URL, key: string) =>
  (url.searchParams.get(key) ?? '').replace(/^in\.\(/, '').replace(/\)$/, '').split(',').filter(Boolean)

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req) => {
  const url = new URL(req.url)
  if (req.url.length > 16_384) return new Response(null, { status: 431 })

  let body: unknown = []
  if (url.pathname === '/rest/v1/lineup_slot_templates') {
    body = [{ slot_type: 'UTIL', slot_count: 1 }]
  } else if (url.pathname === '/rest/v1/roster_players') {
    const members = new Set(inList(url, 'member_id'))
    body = [...owners].filter(([, member]) => members.has(member)).map(([player, member]) => ({
      member_id: member,
      player_id: player,
      acquired_at: '2100-10-01T00:00:00Z',
      is_on_ir: false,
      is_on_taxi: false,
      players: { position: 'PG', eligible_positions: ['PG'] },
    }))
  } else if (url.pathname === '/rest/v1/player_game_stats') {
    const players = inList(url, 'player_id')
    statListSizes.push(players.length)
    for (const player of players) statPlayers.add(player)
    body = players.map((player) => ({
      player_id: player,
      game_date: GAME_DATE,
      points: Number(player.slice(-12)),
      nba_games: { nba_game_id: '0022100001', game_time: `${GAME_DATE}T23:00:00Z`, started_at: null },
    }))
  }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')

const { calcWeekMaxPossiblePointsByMember } = await import('./scoreLineups.ts')

Deno.test('week close scores a league whose rostered players exceed one request line', async () => {
  const result = await calcWeekMaxPossiblePointsByMember(
    [MEMBER_A, MEMBER_B],
    'league',
    'season',
    2101,
    { points: 1 },
    '2101-01-01',
    '2101-01-07',
  )

  // One UTIL starter: each member's best is their highest-scoring player.
  if (result.get(MEMBER_A) !== 300 || result.get(MEMBER_B) !== 451) {
    throw new Error(`unexpected max points ${JSON.stringify([...result])}`)
  }
  if (statPlayers.size !== 451) throw new Error(`stats read for ${statPlayers.size} of 451 players`)
  if (statListSizes.length < 2 || Math.max(...statListSizes) > 150) {
    throw new Error(`stat reads were not batched: ${JSON.stringify(statListSizes)}`)
  }
})

Deno.test({
  name: 'close test server',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await postgrest.shutdown()
  },
})

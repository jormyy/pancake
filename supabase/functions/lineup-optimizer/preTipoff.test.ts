import type { TipoffContext } from './preTipoff.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { tipoffAssignments, processPreTipoff } = await import('./preTipoff.ts')
const { withWorkContext } = await import('../_shared/workContext.ts')

const context = (): TipoffContext => ({
  date: '2026-10-14', seasonYear: 2027, weekNumber: 1,
  templates: [{ slotType: 'PG', count: 1 }, { slotType: 'UTIL', count: 1 }],
  players: [
    { playerId: 'a', eligiblePositions: ['PG'], injuryStatus: null, locked: false, hasGame: true },
    { playerId: 'b', eligiblePositions: ['PG', 'SG'], injuryStatus: null, locked: false, hasGame: true },
    { playerId: 'c', eligiblePositions: ['C'], injuryStatus: null, locked: false, hasGame: true },
    { playerId: 'd', eligiblePositions: ['C'], injuryStatus: null, locked: false, hasGame: true },
  ], stored: [],
})
const projections = [
  { player_id: 'a', projection_fantasy_points: 50 },
  { player_id: 'b', projection_fantasy_points: 40 },
  { player_id: 'c', projection_fantasy_points: 30 },
]
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }

Deno.test('late injury benches an unlocked Out starter and uses fresh projections', () => {
  const c = context()
  const initial = tipoffAssignments(c, projections)
  c.stored = initial.map((entry) => ({ ...entry, locked: false }))
  c.players[0].injuryStatus = 'Out'
  const result = tipoffAssignments(c, [...projections, { player_id: 'd', projection_fantasy_points: 100 }])
  assert(!result.some((row) => row.player_id === 'a') && result.some((row) => row.player_id === 'b'), 'Late Out stays in lineup.')
  assert(result.some((row) => row.player_id === 'd') && !result.some((row) => row.player_id === 'c'), 'Fresh projection does not change the starter.')
  c.players.forEach((p) => { p.injuryStatus = 'Out' })
  assert(tipoffAssignments(c, projections).length === 0, 'An Out player fills an empty slot.')
})

Deno.test('staggered games preserve a locked starter declared Out and leave locked bench players benched', () => {
  const c = context()
  c.stored = [{ player_id: 'a', slot_type: 'PG', is_auto_set: false, week_number: 1, locked: true }]
  c.players[0].locked = true
  c.players[0].injuryStatus = 'Out'
  c.players[1].locked = true
  const result = tipoffAssignments(c, projections)
  assert(JSON.stringify(result[0]) === JSON.stringify({ player_id: 'a', slot_type: 'PG', is_auto_set: false, week_number: 1 }), 'Locked Out starter moves.')
  assert(!result.some((row) => row.player_id === 'b') && result.some((row) => row.player_id === 'c'), 'Locked bench player starts.')
})

Deno.test('departed locked starters keep their slots', () => {
  const c = context()
  c.stored = [{ player_id: 'departed', slot_type: 'PG', is_auto_set: true, week_number: 1, locked: true }]
  const result = tipoffAssignments(c, projections)
  assert(result[0].player_id === 'departed' && result.filter((row) => row.slot_type === 'PG').length === 1, 'Departed lock loses its slot.')
})

Deno.test('multi-position eligibility fills PG SG SF PF C G F and UTIL without duplicates', () => {
  const c = context()
  const slots = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']
  c.templates = slots.map((slotType) => ({ slotType, count: 1 }))
  const eligibility = [['PG', 'SF'], ['SG'], ['SF'], ['PF', 'C'], ['C'], ['PG', 'SG'], ['SF', 'PF'], ['C']]
  c.players = eligibility.map((eligiblePositions, i) => ({ playerId: String(i), eligiblePositions, locked: false, injuryStatus: null, hasGame: true }))
  const result = tipoffAssignments(c, c.players.map((p, i) => ({ player_id: p.playerId, projection_fantasy_points: 10 + i })))
  assert(result.length === 8 && new Set(result.map((row) => row.player_id)).size === 8, 'Eligible slots remain empty or reuse players.')
  for (const row of result) {
    const allowed = row.slot_type === 'UTIL' ? ['PG', 'SG', 'SF', 'PF', 'C'] : row.slot_type === 'G' ? ['PG', 'SG'] : row.slot_type === 'F' ? ['SF', 'PF'] : [row.slot_type]
    assert(c.players.find((p) => p.playerId === row.player_id)!.eligiblePositions.some((pos) => allowed.includes(pos)), 'Ineligible assignment.')
  }
})

Deno.test('postponed games cannot supply new starters and identical retries keep assignments', () => {
  const c = context()
  c.players[0].hasGame = false
  const first = tipoffAssignments(c, projections)
  assert(!first.some((row) => row.player_id === 'a'), 'Postponed player starts.')
  c.stored = first.map((entry) => ({ ...entry, locked: false }))
  assert(JSON.stringify(tipoffAssignments(c, projections)) === JSON.stringify(first), 'Retry changes assignments.')
})


Deno.test('negative projections leave unlocked slots empty when that scores more', () => {
  const c = context()
  const result = tipoffAssignments(c, c.players.map((p) => ({ player_id: p.playerId, projection_fantasy_points: -10 })))
  assert(result.length === 0, 'Negative starters reduce the best projected score.')
})


Deno.test('missing season weeks fail instead of certifying an unprocessed team', () => {
  const c = context()
  c.weekNumber = null
  let failed = false
  try { tipoffAssignments(c, projections) } catch { failed = true }
  assert(failed, 'Missing calendar context silently succeeds.')
})

Deno.test('zero, null, and absent projections fill eligible open starter slots', () => {
  const c = context()
  c.templates = ['PG', 'G', 'C', 'UTIL'].map((slotType) => ({ slotType, count: 1 }))
  for (const scores of [[], [{ player_id: 'a', projection_fantasy_points: 0 }], [
    { player_id: 'a', projection_fantasy_points: null },
    { player_id: 'b', projection_fantasy_points: 40 },
  ]]) {
    const result = tipoffAssignments(c, scores)
    assert(result.length === 4 && new Set(result.map((row) => row.player_id)).size === 4, 'A healthy playing player with no positive projection remains benched beside an empty eligible slot.')
  }
})

Deno.test('a started player without a stored lineup row stays benched at a later tipoff', () => {
  const c = context()
  c.players[0].locked = true
  const result = tipoffAssignments(c, projections)
  assert(!result.some((row) => row.player_id === 'a'), 'A started bench player enters the lineup.')
  assert(c.stored.length === 0 && result.length === 2, 'A started bench player prevents legal unlocked assignments.')
})

Deno.test('teams sharing one tipoff claim do not submit competing apply transactions', async () => {
  const original = globalThis.fetch
  let batches = 0
  let active = 0
  let maximum = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json(batches++ === 0 ? Array.from({ length: 3 }, (_, i) => ({ league_id: 'league', league_season_id: 'season', member_id: `member-${i}` })) : [])
    if (name === 'get_pre_tipoff_lineup_context') return Response.json(context())
    if (name === 'get_league_projection_rows') return Response.json(projections)
    if (name === 'apply_pre_tipoff_lineup') {
      active++
      maximum = Math.max(maximum, active)
      const conflict = active > 1
      await new Promise(resolve => setTimeout(resolve, 30))
      active--
      return conflict ? Response.json({ code: '55P03', message: 'canceling statement due to lock timeout' }, { status: 500 }) : Response.json(true)
    }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(result.failed === 0 && result.optimized === 3, 'A shared tipoff claim fails teams under its own parallel writes.')
    assert(maximum === 1, 'Apply calls compete for the same dispatch row.')
  } finally { globalThis.fetch = original }
})

for (const code of ['55P03', '40P01', '40001', '57014', 'fetch_timeout', '23514', 'persistent']) {
  Deno.test(`tipoff ${code} errors preserve fresh injury guards and bounded failures`, async () => {
    const original = globalThis.fetch
    let batches = 0
    let reads = 0
    let applies = 0
    const transient = !['23514', 'persistent'].includes(code)
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      const name = new URL(req.url).pathname.split('/').at(-1)
      if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
      if (name === 'get_pending_tipoff_members') return Response.json(batches++ === 0 ? [{ league_id: 'league', league_season_id: 'season', member_id: 'member' }] : [])
      if (name === 'get_pre_tipoff_lineup_context') {
        const fresh = context()
        if (reads++ > 0) fresh.players[0].injuryStatus = 'Out'
        return Response.json(fresh)
      }
      if (name === 'get_league_projection_rows') return Response.json(projections)
      if (name === 'apply_pre_tipoff_lineup') {
        applies++
        if (applies === 1 || !transient) return Response.json({ code: code === 'persistent' ? '55P03' : code === 'fetch_timeout' ? '' : code, message: code === 'fetch_timeout' ? 'FetchError: TimeoutError: Signal timed out.' : 'write conflict' }, { status: 500 })
        const body = await req.json()
        assert(!body.p_assignments.some((row: { player_id: string }) => row.player_id === 'a'), 'Retry reuses the injured starter from stale context.')
        return Response.json(true)
      }
      if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
      throw new Error(`Unexpected RPC ${name}`)
    }
    try {
      const result = await processPreTipoff({ tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
      assert(applies === (transient ? 2 : code === 'persistent' ? 5 : 1), 'Retry count does not match the transient error budget.')
      assert(reads === applies, 'A retry does not load current lineup context.')
      assert(result.optimized === (transient ? 1 : 0) && result.failed === (transient ? 0 : 1), 'A transient conflict fails or a permanent failure is hidden.')
    } finally { globalThis.fetch = original }
  })
}

Deno.test('tipoff retries stop before another write when the work lease is lost', async () => {
  const original = globalThis.fetch
  let batches = 0
  let applies = 0
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json(batches++ === 0 ? ['first', 'second'].map(member_id => ({ league_id: 'league', league_season_id: 'season', member_id })) : [])
    if (name === 'get_pre_tipoff_lineup_context') return Response.json(context())
    if (name === 'get_league_projection_rows') return Response.json(projections)
    if (name === 'apply_pre_tipoff_lineup') {
      applies++
      return Response.json({ code: '55P03', message: 'write conflict' }, { status: 500 })
    }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await withWorkContext({ signal: new AbortController().signal, renewLease: () => Promise.reject(new Error('Work lease lost')) }, () => processPreTipoff({ tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' }))
    assert(applies === 1 && result.optimized === 0 && result.failed === 1, 'The optimizer writes again after losing its work lease.')
    assert(result.errors.includes('Work lease lost'), 'The work lease failure is not reported.')
  } finally { globalThis.fetch = original }
})

import type { TipoffContext } from './preTipoff.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { tipoffAssignments } = await import('./preTipoff.ts')

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

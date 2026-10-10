import type { AssignablePlayer } from './assignments.ts'

// The slot map shares a module with the scoring client, which reads these at import.
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { chooseBestAssignments } = await import('./assignments.ts')
const { SLOT_ALLOWED_POSITIONS: SLOT_ELIGIBLE } = await import('../_shared/scoreLineups.ts')

const player = (index: number, eligiblePositions: string[], projected = 10): AssignablePlayer => ({
  playerId: `p${index}`,
  eligiblePositions,
  projected,
  avoidInLineup: false,
})

// One PG at index 0, one C at the last index, everyone between ineligible for PG/C/UTIL.
function boundaryRoster(size: number): AssignablePlayer[] {
  return Array.from({ length: size }, (_, index) =>
    player(index, index === 0 ? ['PG'] : index === size - 1 ? ['C'] : []))
}

Deno.test('auto-set never reuses a player at or beyond the 53-bit Number boundary', () => {
  for (const size of [53, 54, 55, 64, 80]) {
    const assignments = chooseBestAssignments(['PG', 'C', 'UTIL'], boundaryRoster(size), () => true)
    const ids = assignments.map((assignment) => assignment.playerId)
    if (new Set(ids).size !== ids.length) throw new Error(`${size}-player roster reused a player: ${JSON.stringify(assignments)}`)
    // Existing tie rule: skipping PG and using UTIL ties the PG fill and is found first.
    const expected = [{ playerId: `p${size - 1}`, slotType: 'C' }, { playerId: 'p0', slotType: 'UTIL' }]
    if (JSON.stringify(assignments) !== JSON.stringify(expected)) {
      throw new Error(`${size}-player roster chose ${JSON.stringify(assignments)}`)
    }
  }
  const exactAt53 = numberMaskReference(['PG', 'C', 'UTIL'], boundaryRoster(53), () => true)
  if (JSON.stringify(exactAt53) !== JSON.stringify(chooseBestAssignments(['PG', 'C', 'UTIL'], boundaryRoster(53), () => true))) {
    throw new Error('53-player result differs from the exact Number-mask oracle')
  }
  const brokenAt54 = numberMaskReference(['PG', 'C', 'UTIL'], boundaryRoster(54), () => true).map((a) => a.playerId)
  if (new Set(brokenAt54).size === brokenAt54.length) throw new Error('reference no longer reproduces the 54-player defect')
})

// The previous Number-mask solver, exact below 53 players; it is the tie/assignment oracle.
function numberMaskReference(slots: string[], players: AssignablePlayer[], hasGame: (p: AssignablePlayer) => boolean) {
  type Score = { filled: number; healthy: number; game: number; projected: number }
  type Result = { assignments: { playerId: string; slotType: string }[]; score: Score }
  const memo = new Map<string, Result>()
  const compare = (a: Score, b: Score) => a.filled - b.filled || a.healthy - b.healthy || a.game - b.game || a.projected - b.projected
  function search(slotIndex: number, mask: number): Result {
    if (slotIndex >= slots.length) return { assignments: [], score: { filled: 0, healthy: 0, game: 0, projected: 0 } }
    const key = `${slotIndex}:${mask}`
    const cached = memo.get(key)
    if (cached) return cached
    let best = search(slotIndex + 1, mask)
    const eligible = SLOT_ELIGIBLE[slots[slotIndex]] ?? []
    for (let i = 0; i < players.length; i++) {
      if (Math.floor(mask / 2 ** i) % 2 === 1) continue
      const p = players[i]
      if (!p.eligiblePositions.some((position) => eligible.includes(position))) continue
      const next = search(slotIndex + 1, mask + 2 ** i)
      const candidate = {
        assignments: [{ playerId: p.playerId, slotType: slots[slotIndex] }, ...next.assignments],
        score: { filled: next.score.filled + 1, healthy: next.score.healthy + (p.avoidInLineup ? 0 : 1), game: next.score.game + (hasGame(p) ? 1 : 0), projected: next.score.projected + p.projected },
      }
      if (compare(candidate.score, best.score) > 0) best = candidate
    }
    memo.set(key, best)
    return best
  }
  return search(0, 0).assignments
}

Deno.test('auto-set keeps exact assignments and ties for legal rosters below the boundary', () => {
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const positions = ['PG', 'SG', 'SF', 'PF', 'C']
  const slotPool = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL', 'UTIL']
  for (let trial = 0; trial < 400; trial++) {
    const size = 1 + Math.floor(random() * 15)
    const players = Array.from({ length: size }, (_, index) => ({
      ...player(index, positions.filter(() => random() < 0.35), Math.floor(random() * 4) * 5),
      avoidInLineup: random() < 0.2,
    }))
    const slots = slotPool.filter(() => random() < 0.6)
    const gameDay = new Set(players.filter(() => random() < 0.7).map((p) => p.playerId))
    const hasGame = (p: AssignablePlayer) => gameDay.has(p.playerId)
    const actual = JSON.stringify(chooseBestAssignments(slots, players, hasGame))
    const expected = JSON.stringify(numberMaskReference(slots, players, hasGame))
    if (actual !== expected) throw new Error(`trial ${trial} differs: ${actual} vs ${expected}`)
  }
})

import assert from 'node:assert/strict'

const allowed = {
  PG: ['PG'], SG: ['SG'], SF: ['SF'], PF: ['PF'], C: ['C'],
  G: ['PG', 'SG', 'G'], F: ['SF', 'PF', 'F'],
  UTIL: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
}

export function startingSlots(templates) {
  const slots = []
  const seen = new Set()
  for (const row of templates) {
    assert.ok(Object.hasOwn(allowed, row.slot_type) || ['BE', 'IR'].includes(row.slot_type), `Unknown lineup slot ${row.slot_type}`)
    assert.ok(Number.isSafeInteger(row.slot_count) && row.slot_count >= 0, 'Slot count must be a nonnegative integer')
    assert.ok(!seen.has(row.slot_type), `Duplicate slot template ${row.slot_type}`)
    seen.add(row.slot_type)
    if (Object.hasOwn(allowed, row.slot_type)) for (let index = 0; index < row.slot_count; index++) slots.push(row.slot_type)
  }
  assert.ok(slots.length > 0 && slots.length <= 16, 'Independent assignment supports one to sixteen starting slots')
  return slots
}

export function fitsPosition(player, slot) {
  const positions = player.eligible_positions?.length ? player.eligible_positions : [player.position]
  return positions.some(position => allowed[slot]?.includes(position))
}

export function maximumAssignment(players, templates) {
  const slots = startingSlots(templates)
  const identities = new Set()
  let states = new Map([[0, { points: 0, assignments: [] }]])
  for (const player of players) {
    assert.ok(typeof player.player_id === 'string' && player.player_id.length, 'Maximum candidate needs a player identity')
    assert.ok(!identities.has(player.player_id), 'Maximum candidates must contain each player once per date')
    assert.ok(Number.isFinite(player.points), 'Maximum candidate points must be finite')
    identities.add(player.player_id)
    if (player.points <= 0) continue
    const next = new Map(states)
    for (const [mask, state] of states) {
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
        const bit = 1 << slotIndex
        if (mask & bit || !fitsPosition(player, slots[slotIndex])) continue
        const key = mask | bit, points = state.points + player.points
        if ((next.get(key)?.points ?? -Infinity) >= points) continue
        next.set(key, { points, assignments: [...state.assignments, { playerId: player.player_id, slot: slots[slotIndex], slotIndex, points: player.points }] })
      }
    }
    states = next
  }
  return [...states.values()].reduce((best, state) => state.points > best.points ? state : best)
}

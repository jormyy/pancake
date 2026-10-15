import { slots, player } from './fixture.ts'

const eligible: Record<string, string[]> = {
  PG: ['PG'], SG: ['SG'], SF: ['SF'], PF: ['PF'], C: ['C'],
  G: ['PG', 'SG'], F: ['SF', 'PF'], UTIL: ['PG', 'SG', 'SF', 'PF', 'C'],
}
export type Stored = { member_id: string; player_id: string; slot_type: string; game_date: string; id: string; set_at: string }
export type State = { injury: Map<string, string | null>; projections: Map<string, number>; locked: Set<string>; playing: Set<string> }
export function validate(rows: Stored[], state: State, previous: Stored[], optimal: boolean) {
  let checks = 0
  for (let team = 0; team < 10; team++) {
    const roster = Array.from({ length: 10 }, (_, i) => player(team * 10 + i))
    const memberId = roster[0].memberId
    const lineup = rows.filter((row) => row.member_id === memberId)
    const before = previous.filter((row) => row.member_id === memberId)
    if (new Set(lineup.map((row) => row.player_id)).size !== lineup.length) throw new Error('Duplicate player.')
    if (new Set(lineup.map((row) => row.slot_type)).size !== lineup.length) throw new Error('Duplicate slot.')
    for (const row of lineup) {
      const p = roster.find((p) => p.id === row.player_id)
      if (!p || !slots.includes(row.slot_type) || !p.positions.some((position) => eligible[row.slot_type].includes(position))) throw new Error('Illegal starter.')
      const unchanged = before.some((old) => old.player_id === row.player_id && old.slot_type === row.slot_type)
      if (optimal && !state.locked.has(p.id) && !state.playing.has(p.team)) throw new Error('New starter has no game.')
      if (optimal && state.injury.get(p.id) === 'Out' && (!unchanged || !state.locked.has(p.id))) throw new Error('New Out starter.')
      if (state.locked.has(p.id) && !unchanged) throw new Error('New locked starter.')
      checks++
    }
    for (const old of before.filter((row) => state.locked.has(row.player_id))) {
      if (!lineup.some((row) => row.player_id === old.player_id && row.slot_type === old.slot_type && row.id === old.id && row.set_at === old.set_at)) throw new Error('Locked player moved or rewritten.')
      checks++
    }
    if (!optimal) continue
    const locked = before.filter((row) => state.locked.has(row.player_id))
    const openSlots = slots.filter((slot) => !locked.some((row) => row.slot_type === slot))
    let best = new Map<number, number>([[0, 0]])
    for (const p of roster.filter((p) => !state.locked.has(p.id) && state.playing.has(p.team) && state.injury.get(p.id) !== 'Out')) {
      const next = new Map(best)
      for (const [mask, score] of best) {
        for (let slot = 0; slot < openSlots.length; slot++) {
          if (mask & 1 << slot || !p.positions.some((position) => eligible[openSlots[slot]].includes(position))) continue
          const newMask = mask | 1 << slot
          next.set(newMask, Math.max(next.get(newMask) ?? -Infinity, score + (state.projections.get(p.id) ?? 0)))
        }
      }
      best = next
    }
    const maximum = Math.max(...best.values())
    const actual = lineup.filter((row) => !state.locked.has(row.player_id)).reduce((sum, row) => sum + (state.projections.get(row.player_id) ?? 0), 0)
    if (Math.abs(actual - maximum) > 0.00001) throw new Error(`Unlocked lineup is suboptimal: ${actual} vs ${maximum}.`)
    checks++
  }
  return checks
}

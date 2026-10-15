import { player, teams } from './fixture.ts'
import { State, Stored, validate } from './oracle.ts'

const state = (): State => ({
  injury: new Map(), locked: new Set(), playing: new Set(teams),
  projections: new Map(Array.from({ length: 100 }, (_, i) => [player(i).id, 10 + i])),
})
const row = (): Stored => ({
  member_id: player(0).memberId, player_id: player(0).id, slot_type: 'PG',
  game_date: '2025-10-21', id: 'saved-row', set_at: '2025-10-21T22:00:00Z',
})
const rejects = (run: () => unknown, message: string) => {
  try { run() } catch (error) {
    if (String(error).includes(message)) return
    throw error
  }
  throw new Error(`Oracle accepts ${message}`)
}
Deno.test('oracle rejects a legal but suboptimal lineup', () => {
  rejects(() => validate([], state(), [], true), 'suboptimal')
})
Deno.test('oracle rejects duplicate players and ineligible slots', () => {
  rejects(() => validate([row(), { ...row(), slot_type: 'UTIL' }], state(), [], false), 'Duplicate player')
  rejects(() => validate([{ ...row(), slot_type: 'C' }], state(), [], false), 'Illegal starter')
})
Deno.test('oracle rejects an unlocked Out starter even when unchanged', () => {
  const s = state()
  s.injury.set(player(0).id, 'Out')
  rejects(() => validate([row()], s, [row()], true), 'Out starter')
})
Deno.test('oracle rejects a locked starter moved, removed, or rewritten', () => {
  const s = state()
  s.locked.add(player(0).id)
  rejects(() => validate([{ ...row(), slot_type: 'UTIL' }], s, [row()], false), 'New locked starter')
  rejects(() => validate([], s, [row()], false), 'Locked player moved')
  rejects(() => validate([{ ...row(), id: 'replacement' }], s, [row()], false), 'Locked player moved')
})

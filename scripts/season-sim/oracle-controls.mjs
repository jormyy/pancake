import assert from 'node:assert/strict'
import { checkMatchupPoints } from './score-oracle.mjs'

export function scoreCorruptionControls(input, check = checkMatchupPoints) {
  check(input)
  const selected = input.matchups.findIndex(row => row.is_finalized && !row.is_voided)
  assert.ok(selected >= 0, 'Corruption controls require an observed finalized matchup')
  const mutations = [
    { name: 'score', change: value => { value.matchups[selected].home_points = Number(value.matchups[selected].home_points) + 1 } },
    { name: 'maximum', change: value => { value.matchups[selected].home_max_possible_points = Number(value.matchups[selected].home_max_possible_points) + 1 } },
    { name: 'winner', change: value => { const row = value.matchups[selected]; row.winner_member_id = row.winner_member_id === row.home_member_id ? row.away_member_id : row.home_member_id } },
    { name: 'missing-matchups', change: value => { value.matchups = [] } },
  ]
  return mutations.map(({ name, change }) => {
    const corrupted = structuredClone(input)
    change(corrupted)
    assert.throws(() => check(corrupted), undefined, `Oracle did not detect deliberate ${name} corruption`)
    return { name, detected: true, scope: 'Cloned real oracle input; application state remains unchanged' }
  })
}

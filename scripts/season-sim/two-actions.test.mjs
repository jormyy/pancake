import assert from 'node:assert/strict'
import test from 'node:test'
import { intendedOwner } from './two-actions.mjs'

test('rookie owner oracle follows intended trade, drop, and successful waiver actions only', () => {
  const c = { draftedRookies: [{ playerId: 'p', owner: 'a' }], identityMoves: [{ playerId: 'p', owner: 'b', at: 10 }, { playerId: 'p', owner: null, at: 20 }], waiverScenarios: [{ targets: [], input: { claims: [{ id: 'claim', player: 'p', member: 'c' }] }, expected: { claims: { claim: 'succeeded' } }, processAt: 30 }] }
  assert.equal(intendedOwner(c,'p',0),'a')
  assert.equal(intendedOwner(c,'p',15),'b')
  assert.equal(intendedOwner(c,'p',25),null)
  assert.equal(intendedOwner(c,'p',35),'c')
})

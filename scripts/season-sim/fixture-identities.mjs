import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const knownIdentities = JSON.parse(readFileSync(new URL('./known-identities.json', import.meta.url), 'utf8'))

export function fixtureNbaId(gameId, player) {
  const id = String(player.personId)
  const correction = knownIdentities.find(row => row.providerId === id)
  if (!correction) return id
  assert.ok(correction.gameIds.includes(gameId), 'Unreviewed provider identity occurrence')
  assert.equal(player.name, correction.name, 'Provider identity name mismatch')
  return correction.canonicalId
}

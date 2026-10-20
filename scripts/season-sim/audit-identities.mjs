import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { knownIdentities } from './fixture-identities.mjs'

const store = await fixtureStore(path.join(miniRoot, 'fixtures'))
const { games } = /** @type {(text: string | Buffer) => any} */ (JSON.parse)(await readFile(path.join(miniRoot, 'fixtures/games.json')))
const names = new Map()
for (const game of games) {
  const box = await store.json(`boxscore-${game.id}`)
  for (const team of [box.game.homeTeam, box.game.awayTeam]) for (const player of team.players) {
    const row = names.get(player.name) ?? { name: player.name, ids: {} }
    const observations = row.ids[player.personId] ??= []
    const source = store.manifest.get(`boxscore-${game.id}`)
    observations.push({ gameId: game.id, date: game.date, team: team.teamTricode, jersey: player.jerseyNum, played: player.played, reason: player.notPlayingReason, source: { url: source.url, sha256: source.sha256 } })
    names.set(player.name, row)
  }
}
const anomalies = [...names.values()].filter(row => Object.keys(row.ids).length > 1)
assert.equal(anomalies.length, knownIdentities.length, 'Unreviewed cross-game NBA identity inconsistency')
for (const correction of knownIdentities) {
  const row = anomalies.find(row => row.name === correction.name)
  assert.ok(row)
  assert.deepEqual(Object.keys(row.ids).sort(), [correction.providerId, correction.canonicalId].sort())
  assert.deepEqual(row.ids[correction.providerId].map(row => row.gameId).sort(), [...correction.gameIds].sort())
  const corroboration = row.ids[correction.canonicalId].find(row => row.gameId === correction.corroboratingGame)
  assert.ok(corroboration)
  for (const alias of row.ids[correction.providerId]) {
    assert.equal(alias.team, corroboration.team)
    assert.equal(alias.jersey, corroboration.jersey)
    assert.equal(alias.reason, corroboration.reason)
  }
  row.reviewedCorrection = correction
}
await writeJson(path.join(miniRoot, 'evidence/provider-identity-audit.json'), { games: games.length, anomalies, policy: 'Only the pinned source-ID/name correction is accepted. Raw final boxes remain unchanged. Unreviewed identities fail.' })
console.log(JSON.stringify({ games: games.length, anomalies: anomalies.length, canonicalObservations: anomalies.map(row => Object.fromEntries(Object.entries(row.ids).map(([id, observations]) => [id, observations.length]))) }))

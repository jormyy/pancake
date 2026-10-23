import assert from 'node:assert/strict'
import test from 'node:test'
import { recoveryEvidence, recoveryHistoryQuery } from './recovery.mjs'

test('recovery keeps only receipts settled before the checkpoint', () => {
  const clock = Date.parse('2025-03-24T14:00:00Z')
  const snapshot = { clock: { rate: 0, simMs: clock }, quiescence: { polls: 1 }, cursor: { date: '2025-03-24', clock, context: { leagueId: 'l', leagueSeasonId: 's' } } }
  const receipt = { leagueId: 'l', leagueSeasonId: 's', days: [{ date: '2025-03-23', finals: { passed: true, games: 8 } }, { date: '2025-03-24', finals: { passed: true, games: 9 } }], playersEvidence: [{ businessAt: '2025-03-23T09:00:00Z' }, { businessAt: '2025-03-25T09:00:00Z' }], realtime: { passed: true, events: 2 } }
  const profile = { start: '2025-03-23', end: '2025-04-13' }
  const evidence = recoveryEvidence(snapshot, receipt, profile)
  assert.equal(evidence.recovery.retainedGames, 8)
  assert.equal(evidence.recovery.retainedDates, 1)
  assert.equal(evidence.playersEvidence.length, 1)
  assert.equal(evidence.realtime, receipt.realtime)
  assert.equal(evidence.retainedRealtime, true)
  const nextClock = Date.parse('2025-03-25T09:00:00Z')
  const nextSnapshot = { ...snapshot, clock: { ...snapshot.clock, simMs: nextClock }, cursor: { ...snapshot.cursor, clock: nextClock, date: '2025-03-25' } }
  const nextReceipt = { ...receipt, ...evidence, days: [receipt.days[1]] }
  assert.equal(recoveryEvidence(nextSnapshot, nextReceipt, profile).recovery.retainedGames, 17)
  assert.throws(() => recoveryEvidence(nextSnapshot, { ...nextReceipt, days: receipt.days }, profile), /preceding date/)
  assert.throws(() => recoveryEvidence(snapshot, { ...receipt, days: [] }, profile), /preceding date/)
  assert.throws(() => recoveryEvidence(snapshot, { ...receipt, leagueId: 'other' }, profile))
  assert.throws(() => recoveryEvidence({ ...snapshot, clock: { ...snapshot.clock, rate: 1 } }, receipt, profile), /paused/)
  assert.throws(() => recoveryEvidence({ ...snapshot, quiescence: { polls: 0 } }, receipt, profile), /worker drain/)
  assert.throws(() => recoveryHistoryQuery("2025-03-24'; DROP TABLE players; --"))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { recoveryEvidence, recoveryHistoryQuery } from './recovery.mjs'
import { dates } from './common.mjs'

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

test('a completed draft resumes after all settled dates and retains its selected players', () => {
  const profile = { year: 2025, start: '2025-04-12', end: '2025-04-13' }
  const clock = Date.parse('2025-07-05T01:54:00Z')
  const rookies = Array.from({ length: 8 }, (_, id) => ({ playerId: `p${id}`, owner: `m${id % 4}` }))
  const context = { leagueId: 'l', previousSeasonId: 'old', leagueSeasonId: 'new', seasonYear: 2026, users: Array(4).fill({}), draftedRookies: rookies }
  const evidence = Object.fromEntries(['seasonEnd', 'realDraftBoard', 'rookieAutoPick', 'offseasonTrade', 'realRookieActivation'].map(key => [key, { passed: true }]))
  evidence.realRookieActivation.rookies = rookies
  const snapshot = { clock: { rate: 0, simMs: clock }, quiescence: { polls: 1 }, cursor: { date: '2025-04-14', clock, stage: 'post-draft', context, evidence, guard: JSON.stringify({ clock, unfinishedWorkers: 0, cronActive: 'off', cronJobs: 0 }) } }
  const receipt = { leagueId: 'l', leagueSeasonId: 'old', days: dates(profile.start, profile.end).map(date => ({ date, finals: { passed: true, games: 8 } })), champion: { passed: true }, realtime: { passed: true } }
  const recovered = recoveryEvidence(snapshot, receipt, profile)
  assert.equal(recovered.recovery.retainedGames, 16)
  assert.deepEqual(recovered.recovery.retainedReceipts.map(row => row.date), ['2025-04-12', '2025-04-13'])
  assert.equal(recovered.recovery.stage, 'post-draft')
  assert.deepEqual(recovered.realRookieActivation.rookies, rookies)
  assert.equal(recovered.champion, receipt.champion)
  assert.equal(recovered.retainedRealtime, true)
  assert.equal(recoveryEvidence(snapshot, { ...receipt, leagueSeasonId: 'new' }, profile).recovery.retainedDates, 2)
  const bad = change => {
    const candidate = structuredClone(snapshot)
    change(candidate.cursor)
    return candidate
  }
  assert.throws(() => recoveryEvidence(snapshot, { ...receipt, days: receipt.days.slice(0, 1) }, profile), /preceding date/)
  assert.throws(() => recoveryEvidence(snapshot, { ...receipt, leagueSeasonId: 'other' }, profile), /same season transition/)
  assert.throws(() => recoveryEvidence(bad(cursor => { cursor.evidence.rookieAutoPick.passed = false }), receipt, profile), /verified rookieAutoPick/)
  assert.throws(() => recoveryEvidence(bad(cursor => { cursor.context.draftedRookies[1] = cursor.context.draftedRookies[0] }), receipt, profile))
  assert.throws(() => recoveryEvidence(bad(cursor => { cursor.guard = JSON.stringify({ clock, unfinishedWorkers: 1 }) }), receipt, profile), /drained/)
  const activated = bad(cursor => { cursor.clock = Date.parse('2025-08-17T00:00:00Z') })
  activated.clock.simMs = activated.cursor.clock
  assert.throws(() => recoveryEvidence(activated, receipt, profile), /precedes next-season activation/)
})

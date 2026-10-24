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

test('opening recovery retains season one and skips completed preseason work', () => {
  const profile={year:2025,start:'2025-04-12',end:'2025-04-13'}
  const next={year:2026,start:'2025-10-21'}
  const clock=Date.parse('2025-10-21T14:00:11.267Z')
  const rookies=Array.from({length:8},(_,id)=>({playerId:`p${id}`,owner:`m${id%4}`}))
  const context={leagueId:'l',leagueSeasonId:'new',previousSeasonId:'old',seasonYear:2026,firstDate:next.start,users:Array(4).fill({}),draftedRookies:rookies,skippedWeeks:[1]}
  const evidence=Object.fromEntries(['seasonEnd','realDraftBoard','rookieAutoPick','offseasonTrade','realRookieActivation','secondCalendar'].map(key=>[key,{passed:true}]))
  evidence.realRookieActivation.rookies=rookies
  evidence.realSeasonActivation={at:'2025-08-16T14:00:00Z'}
  evidence.skippedWeekSettings={weeks:[1]}
  const snapshot={name:'next-season-start',clock:{rate:0,simMs:clock},quiescence:{polls:1},cursor:{stage:'next-season-start',date:next.start,clock,context,evidence,guard:JSON.stringify({clock,unfinishedWorkers:0,cronActive:'off',cronJobs:0})}}
  const receipt={leagueId:'l',leagueSeasonId:'new',days:[],recovery:{retainedReceipts:dates(profile.start,profile.end).map(date=>({date,finals:{passed:true,games:8}}))},failure:{message:'Replay cannot rewind business time'},failures:[{area:'matchup-order'}],featureCheckpoints:[{year:2025,businessAt:'2025-04-14T14:00Z',f1:{passed:true}},{year:2026,businessAt:'2025-10-21T14:00Z',f1:{status:'FAILED'}}],playersEvidence:[{year:2026,businessAt:'2025-08-16T14:00Z',passed:true}],realtime:{passed:true}}
  const recovered=recoveryEvidence(snapshot,receipt,profile,next)
  assert.equal(recovered.recovery.retainedDates,2)
  assert.equal(recovered.recovery.retainedGames,16)
  assert.equal(recovered.recovery.stage,'next-season-start')
  assert.equal(recovered.realSeasonActivation,evidence.realSeasonActivation)
  assert.equal(recovered.featureCheckpoints.length,1)
  assert.equal(recovered.playersEvidence.length,1)
  assert.equal(recovered.recovery.interruptedFeatureCheckpoints.length,1)
  assert.equal(recovered.interruptions.at(-1).failure.message,receipt.failure.message)
  const bad=change=>{const candidate=structuredClone(snapshot);change(candidate.cursor);return candidate}
  assert.throws(()=>recoveryEvidence(bad(c=>{delete c.guard}),receipt,profile,next))
  assert.throws(()=>recoveryEvidence(bad(c=>{c.evidence.secondCalendar.passed=false}),receipt,profile,next))
  assert.throws(()=>recoveryEvidence(bad(c=>{c.context.skippedWeeks=[]}),receipt,profile,next))
  assert.throws(()=>recoveryEvidence(snapshot,{...receipt,recovery:{retainedReceipts:[]}},profile,next),/preceding date/)
  const settled=structuredClone(snapshot)
  settled.cursor.stage='real-second-season'
  settled.cursor.date='2025-10-23'
  settled.cursor.clock=Date.parse('2025-10-23T09:00Z')
  settled.clock.simMs=settled.cursor.clock
  settled.cursor.guard=JSON.stringify({clock:settled.cursor.clock,unfinishedWorkers:0,cronActive:'off',cronJobs:0})
  settled.cursor.evidence.realSecondProgress={days:['2025-10-21','2025-10-22'].map(date=>({date,finals:{passed:true,games:2},coverage:{checks:2},skippedWeek:{passed:true},realInputs:{date}})),checked:[]}
  const latest={...receipt,nextSeasonProgress:settled.cursor.evidence.realSecondProgress}
  const nextProfile={...next,end:'2026-04-12'}
  const continued=recoveryEvidence(settled,latest,profile,nextProfile)
  assert.equal(continued.recovery.retainedSecondDates,2)
  assert.equal(continued.recovery.retainedGames,20)
  assert.equal(continued.featureCheckpoints.length,2)
  const incomplete=structuredClone(settled)
  incomplete.cursor.evidence.realSecondProgress.days.pop()
  assert.throws(()=>recoveryEvidence(incomplete,latest,profile,nextProfile),/preceding second-season/)
  const wrong=structuredClone(latest)
  wrong.nextSeasonProgress.days[1].finals.games=3
  assert.throws(()=>recoveryEvidence(settled,wrong,profile,nextProfile),/observed daily/)
  const unchecked=structuredClone(settled)
  unchecked.cursor.evidence.realSecondProgress.days[1].finals.passed=false
  assert.throws(()=>recoveryEvidence(unchecked,{...latest,nextSeasonProgress:unchecked.cursor.evidence.realSecondProgress},profile,nextProfile),/completed daily/)
})

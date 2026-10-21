import { dates, season } from './common.mjs'
import assert from 'node:assert/strict'

export function summarizeRun(replay) {
  const failures = [...(replay.failures??[])]
  if(replay.failure&&!failures.some(row=>row.name===replay.failure.name&&row.message===replay.failure.message))failures.push(replay.failure)
  for(const checkpoint of replay.featureCheckpoints??[])for(const[area,key]of [['matchup-order','f1'],['playoff-fit','f2']])if(checkpoint[key]?.status==='FAILED'&&!failures.some(row=>row.area===area&&row.phase===`${checkpoint.year}:${checkpoint.label}`))failures.push({name:'AssertionError',area,phase:`${checkpoint.year}:${checkpoint.label}`,message:checkpoint[key].error})
  for(const row of replay.playersEvidence??[])if(row.status==='FAILED'&&!failures.some(failure=>failure.area==='players-sort'&&failure.phase===`${row.year}:${row.label}`))failures.push({name:'AssertionError',area:'players-sort',phase:`${row.year}:${row.label}`,message:row.error})
  if(replay.draftPushes?.status==='FAILED'&&!failures.some(row=>row.area==='notifications'))failures.push({name:'AssertionError',area:'notifications',message:replay.draftPushes.error})
  const invariantFailures = failures.filter(failure => failure.name === 'AssertionError').length
  const unclassifiedFailures = failures.filter(failure => !failure.name).length
  const summary = {
    scope: 'Card-area outcomes; ancillary ranking and projection quality is excluded',
    startedAt: replay.startedAt, finishedAt: replay.finishedAt ?? null,
    wallSeconds: replay.wallSeconds ?? null, complete: replay.complete === true,
    fullAcceptance: replay.fullAcceptance === true, completedDates: replay.days.length+(replay.realTwoSeasons?replay.nextSeasonProgress?.days.length??0:0),
    requestedDates: replay.dates.length+(replay.requestedSecondDates??0), failures, invariantFailures: unclassifiedFailures ? null : invariantFailures,
    executionFailures: failures.filter(failure => failure.name && failure.name !== 'AssertionError').length + (replay.triggerFidelity?.unsupportedInputs?.length ?? 0)+(replay.sourceUnavailable?.length??0),
    segments: replay.segments ?? [], interruptions: replay.interruptions ?? [],
    defectEvidence: replay.defectEvidence ?? [], datasetEvidence: replay.datasetEvidence ?? [],
    triggerFidelity: replay.triggerFidelity ?? { verified: false },
    acceptanceGaps: replay.acceptanceGaps ?? [], areas: acceptanceAreas(replay),
    expectedSourceUnavailable: replay.sourceUnavailable ?? [],
    withinDeclaredBudget: replay.wallBudgetSeconds == null || replay.wallSeconds == null ? null : replay.wallSeconds <= replay.wallBudgetSeconds,
    withinTwelveHours: !replay.complete || replay.wallSeconds == null ? null : replay.wallSeconds <= 43200,
  }
  assert.ok(!summary.fullAcceptance || (summary.complete && !failures.length && !summary.acceptanceGaps.length && summary.triggerFidelity.verified && !acceptanceGaps(replay).length), 'Full acceptance requires complete measured coverage and production triggers')
  return summary
}

export function executionNotes(replay) {
  const notes = []
  if (replay.segments?.length > 1) notes.push('Active time sums the recorded execution segments.')
  if (replay.interruptions?.length) notes.push(`Recorded interruptions: ${replay.interruptions.length}.`)
  if (replay.elapsedIncludingPauseSeconds != null && replay.interruptions?.length) notes.push(`Elapsed time including pauses: ${replay.elapsedIncludingPauseSeconds} seconds.`)
  if (replay.continuation === true) notes.push('This run starts from retained state. It does not count as a fresh replay.')
  return notes.join('\n')
}

export function countersBelongToRun(upstream, replay) {
  return !!(upstream.startedAt && upstream.lastEventRealAt && upstream.startedAt >= replay.startedAt && upstream.lastEventRealAt <= replay.finishedAt)
}

export function acceptanceAreas(run) {
  const waivers = run.waivers ?? []
  const checked = name => waivers.some(row => row.name === name && row.checked && row.result?.passed)
  const yes = value => value ? 'pass' : 'not measured'
  const areas = {
    'live streams': yes(run.liveSamples > 0 && run.realtime?.passed),
    'weekly scoring': yes(run.days.some(day => day.weekly?.length > 0) && run.nextSeason?.checked?.includes(3)),
    playoffs: yes(run.seasonEnd?.playoffGames > 0 && run.seasonEnd?.passed),
    champion: yes(run.champion?.passed),
    'trade deadline': yes(run.actions?.tradeDeadline?.postDeadlinePassed && run.tradingReopened?.passed),
    'rookie draft': yes(run.rookieAutoPick?.passed && run.seasonEnd?.rookiePicks > 0),
    'picks across seasons': yes(run.pickAllocation?.passed && run.offseasonTrade?.passed && run.nextSeason?.historyPreserved),
    FAAB: yes(checked('season-one-faab')),
    'rolling order': yes(checked('skipped-week-rolling') && checked('eligible-week-rolling')),
    'waiver limits': yes(checked('season-one-faab') && checked('eligible-week-rolling') && run.waiverRollover?.passed),
    'skipped week 1 / first eligible week': yes(run.nextSeason?.passed && run.nextSeason?.checked?.join(',') === '2,3'),
    rollover: yes(run.seasonEnd?.historyPreserved && run.waiverRollover?.passed && run.nextSeason?.historyPreserved),
  }
  if (run.realTwoSeasons) {
    areas['live streams']=yes(run.liveSamples>0&&run.realtime?.passed&&run.realtimeSecond?.passed)
    const checkpoints=run.featureCheckpoints??[],players=run.playersEvidence??[]
    const checkedFeature=(rows,complete)=>rows.some(row=>row.status==='FAILED')?'fail':yes(complete)
    areas['matchup order']=checkedFeature(checkpoints.map(row=>row.f1),[2025,2026].every(year=>['week-1','mid-season','final'].every(label=>checkpoints.some(row=>row.year===year&&row.label===label&&row.f1.passed))))
    areas['playoff fit']=checkedFeature(checkpoints.map(row=>row.f2),[2025,2026].every(year=>checkpoints.some(row=>row.year===year&&row.label==='final'&&row.f2.champions===1&&row.f2.passed)))
    areas['Players FP/game']=checkedFeature(players,[2025,2026].every(year=>['opening-before-played','after-first-final',...(year===2026?['preseason']:[])].every(label=>players.some(row=>row.year===year&&row.label===label&&row.passed))))
    areas['your-turn pushes']=run.draftPushes?.status==='FAILED'?'fail':yes(run.draftPushes?.passed)
    areas['rookie timer']=yes(run.rookieAutoPick?.timerSeconds>=60&&run.rookiePause?.length>0&&run.rookiePause.every(row=>row.passed))

    const status = (name,value) => run.failure?.area?.includes(name) ? 'fail' : yes(value)
    Object.assign(areas,{
      'opening night':status('opening-night',run.firstCalendar?.passed && run.secondCalendar?.passed),
      'All-Star week':status('all-star-week',run.allStarLimits?.length===2 && run.allStarLimits.every(row=>row.passed)),
      'NBA Cup':status('nba-cup',run.firstCalendar?.cupFinalsExcluded?.length===1 && run.secondCalendar?.cupFinalsExcluded?.length===1),
      postponements:status('postponement',new Set((run.realInputChecks??[]).flatMap(day=>day.postponements.filter(row=>day.date>=(run.inputPostponements??[]).find(input=>input.id===row.gameId)?.makeupDate).map(row=>row.gameId))).size >= 6),
      'rookie identity':status('rookie-identity',run.realRookieCoverage?.passed),
      'NBA deadline trades':status('nba-trades',new Set((run.nbaTrades??[]).filter(row=>row.passed).map(row=>row.year)).size===2),
    })
    areas['skipped week 1 / first eligible week']=yes(run.nextSeason?.passed && run.nextSeason?.checked?.includes(2))
  }
  return areas
}

export function acceptanceGaps(run) {
  const gaps = Object.entries(acceptanceAreas(run)).filter(([, value]) => value !== 'pass').map(([name]) => `Unverified: ${name}`)
  const range=run.historicalRange??{start:season.start,dates:dates(season.start,season.end).length}
  if (!run.complete || run.days.length !== range.dates || run.dates[0] !== range.start) gaps.push('A complete historical replay remains required')
  if (!run.freshDatabase || run.continuation || run.interruptions?.length) gaps.push('A fresh uninterrupted database replay remains required')
  if (!run.source?.committedHarness) gaps.push('The running harness differs from the committed application archive')
  if (!run.triggerFidelity?.verified) gaps.push('Production trigger coverage remains unverified')
  if (run.failure || run.failures?.length) gaps.push('The run has failures')
  return gaps
}

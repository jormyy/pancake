import assert from 'node:assert/strict'
import { dates } from './common.mjs'
import { shiftDay } from './season-model.mjs'

export const draftRecoveryFields = ['seasonEnd', 'realDraftBoard', 'rookieAutoPick', 'rookiePause', 'draftPushes', 'pickAllocation', 'offseasonTrade', 'previousChampion', 'realRookieActivation']
export const openingRecoveryFields = [...draftRecoveryFields,'realSeasonActivation','skippedWeekSettings','secondCalendar']
export const realSecondRecoveryFields = [...openingRecoveryFields,'realSecondProgress','realRookieActions','rookieActionDates','waiverWeekResets']

export function recoveryEvidence(snapshot, receipt, profile, nextProfile = null) {
  const cursor = snapshot.cursor
  const postDraft = cursor.stage === 'post-draft'
  const opening = cursor.stage === 'next-season-start'
  const realSecond = cursor.stage === 'real-second-season'
  const transition = postDraft || opening || realSecond
  assert.equal(snapshot.clock.rate, 0, 'Recovery requires a paused checkpoint')
  assert.equal(snapshot.quiescence.workers?.length ?? 0, 0)
  assert.equal(snapshot.quiescence.polls > 0, true, 'Recovery requires an observed worker drain')
  assert.equal(cursor.clock, snapshot.clock.simMs ?? snapshot.clock.sim_ms)
  if (transition) {
    if (opening || realSecond) {
      if (opening) assert.equal(cursor.date,nextProfile?.start,'Opening recovery starts on the next real opening date')
      assert.equal(cursor.context.firstDate,nextProfile.start)
      const hour = realSecond ? '09' : '14'
      assert.ok(cursor.clock>=Date.parse(`${cursor.date}T${hour}:00:00Z`)&&cursor.clock<Date.parse(`${cursor.date}T${hour}:02:00Z`),'Recovery stays inside its drained morning boundary')
      if (realSecond) {
        assert.ok(cursor.date > nextProfile.start && cursor.date <= shiftDay(nextProfile.end, 1))
        const progress = cursor.evidence.realSecondProgress
        assert.deepEqual(progress.days.map(row => row.date), dates(nextProfile.start, cursor.date).slice(0, -1), 'Real recovery retains every preceding second-season date')
        assert.deepEqual(progress.days, receipt.nextSeasonProgress.days, 'Real recovery uses the observed daily receipts')
        assert.ok(progress.days.every(row => row.finals.passed && row.coverage && row.skippedWeek.passed && row.realInputs.date === row.date), 'Real recovery requires completed daily assertions')
        assert.equal(new Set(progress.checked).size, progress.checked.length)
      }
      assert.equal(cursor.evidence?.secondCalendar?.passed,true)
      assert.ok(cursor.evidence?.realSeasonActivation?.at)
      assert.deepEqual(cursor.context.skippedWeeks,[1])
      assert.deepEqual(cursor.evidence.skippedWeekSettings?.weeks,[1])
    } else {
      assert.equal(cursor.date, shiftDay(profile.end, 1), 'Post-draft recovery retains the entire settled first season')
      assert.ok(cursor.clock >= Date.parse(`${cursor.date}T00:00:00Z`) && cursor.clock < Date.parse(`${profile.year}-08-16T14:00:00Z`), 'Post-draft recovery precedes next-season activation')
    }
    assert.ok([cursor.context.previousSeasonId, cursor.context.leagueSeasonId].includes(receipt.leagueSeasonId), 'Post-draft receipt belongs to the same season transition')
    assert.notEqual(cursor.context.leagueSeasonId, cursor.context.previousSeasonId)
    assert.equal(cursor.context.seasonYear, profile.year + 1)
    for (const key of ['seasonEnd', 'realDraftBoard', 'rookieAutoPick', 'offseasonTrade', 'realRookieActivation']) assert.equal(cursor.evidence?.[key]?.passed, true, `Post-draft recovery requires verified ${key}`)
    assert.equal(cursor.context.draftedRookies.length, cursor.context.users.length * 2)
    assert.equal(new Set(cursor.context.draftedRookies.map(row => row.playerId)).size, cursor.context.draftedRookies.length)
    const guard = JSON.parse(cursor.guard)
    assert.equal(guard.unfinishedWorkers, 0, 'Post-draft recovery requires drained stored work')
    assert.equal(guard.clock, cursor.clock)
    assert.equal(guard.cronActive, 'off')
    assert.equal(guard.cronJobs, 0)
  } else {
    assert.ok(cursor.date >= profile.start && cursor.date <= profile.end)
    assert.ok(cursor.clock < Date.parse(`${cursor.date}T23:59:59Z`), 'Recovery cursor cannot pass its first date')
  }
  const retainedEnd=opening||realSecond?shiftDay(profile.end,1):cursor.date
  const days = [...(receipt.recovery?.retainedReceipts ?? []), ...receipt.days].filter(day => day.date < retainedEnd)
  assert.deepEqual(days.map(day => day.date), dates(profile.start, retainedEnd).slice(0, -1), 'Recovery requires every preceding date receipt')
  assert.ok(days.every(day => day.finals.passed || day.finals.games === 0), 'Recovery requires verified preceding finals')
  assert.equal(receipt.leagueId, cursor.context.leagueId)
  if (!transition) assert.equal(receipt.leagueSeasonId, cursor.context.leagueSeasonId)
  const before = row => Date.parse(row.businessAt) <= cursor.clock
  const retained = Object.fromEntries(['firstCalendar', 'champion', 'pendingWaiversAtChampion', 'tradingReopened', 'rolloverRecovery', 'rolloverHistory', 'waiverRollover', 'sourceUnavailable'].filter(key => receipt[key] !== undefined).map(key => [key, receipt[key]]))
  if (transition) Object.assign(retained, Object.fromEntries((realSecond?realSecondRecoveryFields:opening?openingRecoveryFields:draftRecoveryFields).map(key => [key, cursor.evidence[key]])))
  return Object.assign(retained, {
    ...(opening||realSecond?{interruptions:[...(receipt.interruptions??[]),{phase:receipt.phase,failure:receipt.failure??null,failures:receipt.failures??[],source:receipt.source?.application,dumpSha256:snapshot.dumpSha256}]}:{}),
    featureCheckpoints: (receipt.featureCheckpoints ?? []).filter(row=>before(row)&&(!opening||row.year<nextProfile.year)),
    playersEvidence: (receipt.playersEvidence ?? []).filter(before),
    realInputChecks: (receipt.realInputChecks ?? []).filter(row => row.date < cursor.date),
    nbaTrades: (receipt.nbaTrades ?? []).filter(row => row.firstAfter < cursor.date),
    waivers: (receipt.waivers ?? []).filter(row => Date.parse(row.checkedAt) <= cursor.clock),
    allStarLimits: (receipt.allStarLimits ?? []).filter(row => row.checked < cursor.date),
    realtime: receipt.realtime,
    retainedRealtime: !!receipt.realtime,
    recovery: { date: cursor.date, clock: cursor.clock, stage: cursor.stage ?? null, retainedDates: days.length, retainedGames: days.reduce((sum, day) => sum + day.finals.games, 0)+(realSecond?cursor.evidence.realSecondProgress.days.reduce((sum,day)=>sum+day.finals.games,0):0), retainedSecondDates: realSecond?cursor.evidence.realSecondProgress.days.length:0, retainedReceipts: days.map(({ date, finals }) => ({ date, finals })), dumpSha256: snapshot.dumpSha256, guard: transition ? cursor.guard : null, ...(opening?{interruptedFeatureCheckpoints:(receipt.featureCheckpoints??[]).filter(row=>row.year===nextProfile.year)}:{}) },
  })
}

export function postDraftStateQuery() {
  const tables = ['nba_games', 'player_game_stats', 'weekly_lineups', 'matchups', 'standings', 'league_seasons', 'roster_players', 'roster_transactions', 'players', 'draft_picks', 'drafts', 'snake_draft_picks', 'draft_orders', 'draft_audit_logs', 'trades', 'trade_items']
  return `SELECT json_build_object('clock',extract(epoch FROM now())*1000,'unfinishedWorkers',(SELECT count(*) FROM edge_invocations WHERE worker_status IN ('pending','running')),'cronActive',current_setting('cron.launch_active_jobs'),'cronJobs',(SELECT count(*) FROM cron.job),${tables.map(table => `'${table}',(SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY t.id)) FROM ${table} t)`).join(',')})`
}

export function recoveryHistoryQuery(date) {
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
  return `SELECT json_build_object(
    'games',(SELECT count(*) FROM nba_games WHERE game_date<'${date}' AND status='Final'),
    'stats',(SELECT md5(string_agg((to_jsonb(s)-'updated_at')::text,'' ORDER BY s.id)) FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.game_date<'${date}'),
    'lineups',(SELECT md5(string_agg((to_jsonb(l)-'updated_at')::text,'' ORDER BY l.id)) FROM weekly_lineups l WHERE l.game_date<'${date}'),
    'matchups',(SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY m.id)) FROM matchups m JOIN league_seasons l ON l.id=m.league_season_id JOIN season_weeks w ON w.season_year=l.season_year AND w.week_number=coalesce(m.end_week_number,m.week_number) WHERE m.is_finalized AND w.week_end<'${date}'))`
}

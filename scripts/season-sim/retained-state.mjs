import assert from 'node:assert/strict'

export function retainedChampionCursor({ snapshot, retained, clock, currentSeason, final, stage = 'automatic-champion' }) {
  assert.ok(retained.champion?.passed, 'Retained run must already prove the automatic champion')
  assert.equal(snapshot.cursor.context.leagueSeasonId, retained.leagueSeasonId, 'Retained context uses the same season')
  assert.ok(['automatic-champion', 'post-rollover'].includes(stage), 'Supported retained checkpoint')
  assert.equal(currentSeason, stage === 'post-rollover' ? retained.rolloverRecovery?.season : retained.leagueSeasonId, 'Retained database matches the checkpoint season')
  assert.equal(final?.id, retained.champion.matchupId, 'Retained final matches the champion checkpoint')
  assert.ok(final.is_finalized, 'Retained final is finalized')
  assert.equal(final.winner_member_id, retained.champion.memberId, 'Retained champion remains unchanged')
  assert.equal(clock.rate, 0, 'Retained clock must be paused')
  assert.ok(clock.simMs >= Date.parse(final.finalized_at), 'Retained clock follows champion finalization')
  const context = structuredClone(snapshot.cursor.context)
  const scenarios = new Map((context.waiverScenarios ?? []).map(row => [row.name, row]))
  for (const row of retained.waivers ?? []) scenarios.set(row.name, structuredClone(row))
  context.waiverScenarios = [...scenarios.values()]
  const latest = context.waiverScenarios.filter(row => row.checked).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0]
  if (latest) { context.expectedWaiverPriorities = latest.expected.priorities; context.expectedWaiverBudgets = latest.expected.budgets }
  if (stage === 'post-rollover') { context.previousSeasonId = retained.leagueSeasonId; context.previousChampionId = final.id; context.leagueSeasonId = currentSeason }
  return { date: '2026-04-12', clock: clock.simMs, verifiedWeeks: snapshot.cursor.verifiedWeeks ?? [], context, actions: retained.actions, options: { days: 1 }, evidence: { retainedCheckpoint: { phase: retained.phase, completedDates: retained.days.length, failure: retained.failure, source: retained.source, savedAt: retained.savedAt } } }
}

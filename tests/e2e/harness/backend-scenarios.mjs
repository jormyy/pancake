import { createScenarioResourceOwner, throwWithCleanup } from '../scenario-resource-owner.mjs'
import { BACKEND_SCENARIO_MANIFEST } from '../backend-scenario-manifest.mjs'

const runnerById = {
  'league-lifecycle': ({ runners, context }) => runners.assertLeagueLifecycleScenario(context),
  auction: ({ runners, context }) => runners.assertAuctionBidValidation({
      supabase: context.supabase,
      leagueId: context.leagueId,
      season: context.season,
      resourceOwner: context.resourceOwner,
    }),
  playoffs: ({ runners, context }) => runners.assertPlayoffBracketScenario(context),
  tiebreakers: ({ runners, context }) => runners.assertStandingsTiebreakerScenario(context),
  settings: ({ runners, context }) => runners.assertCommissionerSettingsScenario(context),
  scoring: ({ runners, context }) => runners.assertWeeklyScoringFinalizationScenario(context),
  'waiver-processing': ({ runners, context }) => runners.assertWaiverProcessingScenario(context),
  'injury-filter': ({ runners, context }) => runners.assertInjuryStatusFilterScenario({
      supabase: context.supabase,
      env: context.env,
      season: context.season,
      fakePort: context.fakePort,
      resourceOwner: context.resourceOwner,
    }),
  'trade-accept': ({ runners, context }) => runners.assertTradeAcceptanceAtomicityScenario(context),
  'trade-veto': ({ runners, context }) => runners.assertTradeVetoScenario(context),
  'rookie-draft': ({ runners, context }) => runners.assertRookieDraftAutoPickScenario(context),
  'draft-push': ({ runners, context }) => runners.assertDraftPushNotification({
      supabase: context.supabase,
      env: context.env,
      state: context.state,
      season: context.season,
      fakePort: context.fakePort,
      resourceOwner: context.resourceOwner,
    }),
  'season-reset': ({ runners, context }) => runners.assertSeasonResetScenario(context),
  'offseason-activity': ({ runners, context }) => runners.assertOffseasonActivityScenario(context),
}

const BACKEND_SCENARIOS = BACKEND_SCENARIO_MANIFEST.map((scenario) => ({
  ...scenario,
  run: runnerById[scenario.id],
}))

if (BACKEND_SCENARIOS.some((scenario) => typeof scenario.run !== 'function') ||
  Object.keys(runnerById).length !== BACKEND_SCENARIOS.length) {
  throw new Error('Backend scenario manifest and runners are out of sync')
}

export async function runBackendScenarios({ args, context, runners, shouldRun }) {
  const results = Object.fromEntries(
    BACKEND_SCENARIOS.flatMap((scenario) => [
      [scenario.resultKey, null],
      ...(scenario.failuresKey ? [[scenario.failuresKey, []]] : []),
    ]),
  )

  for (const scenario of BACKEND_SCENARIOS) {
    if (!args[scenario.flag] || !shouldRun(args, context.season)) continue

    const resourceOwner = createScenarioResourceOwner(`backend ${scenario.flag}`)
    let check
    let primaryError = null
    try {
      check = await scenario.run({ context: { ...context, resourceOwner }, runners })
    } catch (error) {
      primaryError = error
    }
    let cleanupError = null
    try {
      await resourceOwner.dispose()
    } catch (error) {
      cleanupError = error
    }
    throwWithCleanup(primaryError, cleanupError, `backend ${scenario.flag}`)
    results[scenario.resultKey] = check
    if (scenario.failuresKey) {
      results[scenario.failuresKey].push(...(check?.failures ?? []))
    }
  }

  return results
}

export function backendScenarioFailures(results) {
  return BACKEND_SCENARIOS.flatMap((scenario) =>
    scenario.failuresKey ? results[scenario.failuresKey] ?? [] : [],
  )
}

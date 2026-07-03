const BACKEND_SCENARIOS = [
  {
    flag: 'leagueLifecycle',
    resultKey: 'leagueLifecycleCheck',
    failuresKey: 'leagueLifecycleFailures',
    run: ({ runners, context }) => runners.assertLeagueLifecycleScenario(context),
  },
  {
    flag: 'auction',
    resultKey: 'auctionValidation',
    run: ({ runners, context }) => runners.assertAuctionBidValidation({
      supabase: context.supabase,
      leagueId: context.leagueId,
      season: context.season,
    }),
  },
  {
    flag: 'playoffs',
    resultKey: 'playoffCheck',
    failuresKey: 'playoffFailures',
    run: ({ runners, context }) => runners.assertPlayoffBracketScenario(context),
  },
  {
    flag: 'tiebreakers',
    resultKey: 'tiebreakerCheck',
    failuresKey: 'tiebreakerFailures',
    run: ({ runners, context }) => runners.assertStandingsTiebreakerScenario(context),
  },
  {
    flag: 'settings',
    resultKey: 'settingsCheck',
    failuresKey: 'settingsFailures',
    run: ({ runners, context }) => runners.assertCommissionerSettingsScenario(context),
  },
  {
    flag: 'scoring',
    resultKey: 'scoringCheck',
    failuresKey: 'scoringFailures',
    run: ({ runners, context }) => runners.assertWeeklyScoringFinalizationScenario(context),
  },
  {
    flag: 'waiverProcessing',
    resultKey: 'waiverProcessingCheck',
    failuresKey: 'waiverProcessingFailures',
    run: ({ runners, context }) => runners.assertWaiverProcessingScenario(context),
  },
  {
    flag: 'injuryFilter',
    resultKey: 'injuryFilterCheck',
    failuresKey: 'injuryFilterFailures',
    run: ({ runners, context }) => runners.assertInjuryStatusFilterScenario({
      supabase: context.supabase,
      env: context.env,
      season: context.season,
      fakePort: context.fakePort,
    }),
  },
  {
    flag: 'tradeAccept',
    resultKey: 'tradeAcceptCheck',
    failuresKey: 'tradeAcceptFailures',
    run: ({ runners, context }) => runners.assertTradeAcceptanceAtomicityScenario(context),
  },
  {
    flag: 'tradeVeto',
    resultKey: 'tradeVetoCheck',
    failuresKey: 'tradeVetoFailures',
    run: ({ runners, context }) => runners.assertTradeVetoScenario(context),
  },
  {
    flag: 'rookieDraft',
    resultKey: 'rookieDraftCheck',
    failuresKey: 'rookieDraftFailures',
    run: ({ runners, context }) => runners.assertRookieDraftAutoPickScenario(context),
  },
  {
    flag: 'draftPush',
    resultKey: 'draftPushCheck',
    failuresKey: 'draftPushFailures',
    run: ({ runners, context }) => runners.assertDraftPushNotification({
      supabase: context.supabase,
      env: context.env,
      state: context.state,
      season: context.season,
      fakePort: context.fakePort,
    }),
  },
  {
    flag: 'seasonReset',
    resultKey: 'seasonResetCheck',
    failuresKey: 'seasonResetFailures',
    run: ({ runners, context }) => runners.assertSeasonResetScenario(context),
  },
]

export async function runBackendScenarios({ args, context, runners, shouldRun }) {
  const results = Object.fromEntries(
    BACKEND_SCENARIOS.flatMap((scenario) => [
      [scenario.resultKey, null],
      ...(scenario.failuresKey ? [[scenario.failuresKey, []]] : []),
    ]),
  )

  for (const scenario of BACKEND_SCENARIOS) {
    if (!args[scenario.flag] || !shouldRun(args, context.season)) continue

    const check = await scenario.run({ context, runners })
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

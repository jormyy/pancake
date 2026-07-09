import {
  ARTIFACT_ROOT,
  MEMORY_DRIFT_LIMIT,
  MEMORY_DRIFT_MIN_BYTES,
  MEMORY_HEAP_DRIFT_MIN_BYTES,
  MIDLIFE_MIGRATION_AFTER_SEASON,
  PERF_DRIFT_LIMIT,
  PERF_METRICS_PATH,
  REALTIME_CLIENTS,
  ROOT,
  assertEnv,
  assertFuturePickMaterializedInRookieDraft,
  assertHistoryRetained,
  assertMatchupGenerationIdempotent,
  backendScenarioFailures,
  createClient,
  createFakeUpstreamServer,
  currentMemory,
  describeEndpoint,
  ensureHistoryFixtureForSeason,
  errorMessage,
  fetchSingle,
  mkdir,
  nowMs,
  parseArgs,
  path,
  readState,
  resolvedEnv,
  roundedMs,
  runBackendScenarios,
  runBrowserScenarios,
  runSchemaPreflight,
  setupFuturePickChain,
  shouldRunScenario,
  timestamp,
  validateMemoryDrift,
  validatePerfDrift,
  validateSnapshotProgress,
  writeCoverageReport,
  writeFile,
  writeReport,
  writeSnapshots,
} from './soak-support.mjs'
import {
  applyMidlifeMigration,
  assertRealtimeDelivery,
  runInvariants,
} from './soak-realtime-invariants.mjs'
import {
  assertAuctionBidValidation,
  assertCorsPreflight,
  assertDraftPushNotification,
  assertPushNotifications,
  assertWaiverProcessingScenario,
} from './soak-waiver-push.mjs'
import {
  assertBackendUsesFakePush,
  backendGetJson,
  backendJson,
  postJson,
} from './soak-backend-support.mjs'
import {
  assertCommissionerSettingsScenario,
  assertInjuryStatusFilterScenario,
  assertLeagueLifecycleScenario,
  assertTradeAcceptanceAtomicityScenario,
  assertTradeVetoScenario,
} from './soak-trade-lifecycle.mjs'
import {
  assertPlayoffBracketScenario,
  assertRookieDraftAutoPickScenario,
  assertStandingsTiebreakerScenario,
} from './soak-draft-playoff.mjs'
import {
  assertSeasonResetScenario,
  assertWeeklyScoringFinalizationScenario,
} from './soak-scoring-reset.mjs'

const main = async () => {
  const args = parseArgs()
  if (!Number.isInteger(args.seasons) || args.seasons < 1) {
    throw new Error('--seasons must be a positive integer')
  }

  process.env.FAKE_UPSTREAM_PORT = String(args.fakePort)
  await assertEnv(args.seasons)
  const env = resolvedEnv()
  const state = await readState()
  const targetLeagueId = process.env.E2E_LEAGUE_ID ?? state?.leagueId ?? null
  if (env.backendTicksEnabled && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_BACKEND_TICKS=1 requires E2E_ADMIN_SECRET')
  }
  if (env.backendTicksEnabled && !targetLeagueId) {
    throw new Error('E2E_ENABLE_BACKEND_TICKS=1 requires a seeded target league or E2E_LEAGUE_ID')
  }
  if (args.pickChain && !targetLeagueId) {
    throw new Error('E2E_ENABLE_PICK_CHAIN=1 requires a seeded target league or E2E_LEAGUE_ID')
  }
  if (args.push && (!env.backendTicksEnabled || !targetLeagueId)) {
    throw new Error('E2E_ENABLE_PUSH=1 requires E2E_ENABLE_BACKEND_TICKS=1 and a seeded target league')
  }
  if (args.leagueLifecycle && (!state?.password || !Array.isArray(state.users) || state.users.length < 10)) {
    throw new Error('E2E_ENABLE_LEAGUE_LIFECYCLE=1 requires tests/e2e-state.json from npm run e2e:seed with 10 users')
  }
  if (args.draftPush && (!state?.password || !Array.isArray(state.users) || state.users.length < 4)) {
    throw new Error('E2E_ENABLE_DRAFT_PUSH=1 requires tests/e2e-state.json from npm run e2e:seed with at least 4 users')
  }
  if (args.draftPush && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_DRAFT_PUSH=1 requires E2E_ADMIN_SECRET and a Supabase Edge API configured with E2E_ADMIN_SECRET')
  }
  if (args.history && (!env.backendTicksEnabled || !targetLeagueId)) {
    throw new Error('E2E_ENABLE_HISTORY=1 requires E2E_ENABLE_BACKEND_TICKS=1 and a seeded target league')
  }
  if (args.realtime && !targetLeagueId) {
    throw new Error('E2E_ENABLE_REALTIME=1 requires a seeded target league or E2E_LEAGUE_ID')
  }
  if (args.auction && !targetLeagueId) {
    throw new Error('E2E_ENABLE_AUCTION=1 requires a seeded target league or E2E_LEAGUE_ID')
  }
  if (args.playoffs && (!state?.password || !Array.isArray(state.users) || state.users.length < 10)) {
    throw new Error('E2E_ENABLE_PLAYOFFS=1 requires tests/e2e-state.json from npm run e2e:seed with 10 users')
  }
  if (args.tiebreakers && (!state?.password || !Array.isArray(state.users) || state.users.length < 4)) {
    throw new Error('E2E_ENABLE_TIEBREAKERS=1 requires tests/e2e-state.json from npm run e2e:seed with at least 4 users')
  }
  if (args.settings && (!state?.password || !Array.isArray(state.users) || state.users.length < 2)) {
    throw new Error('E2E_ENABLE_SETTINGS=1 requires tests/e2e-state.json from npm run e2e:seed with at least 2 users')
  }
  if (args.scoring && (!state?.password || !Array.isArray(state.users) || state.users.length < 2)) {
    throw new Error('E2E_ENABLE_SCORING=1 requires tests/e2e-state.json from npm run e2e:seed with at least 2 users')
  }
  if (args.scoring && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_SCORING=1 requires E2E_ADMIN_SECRET and a Supabase Edge API configured with E2E_ADMIN_SECRET')
  }
  if (args.injuryFilter && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_INJURY_FILTER=1 requires E2E_ADMIN_SECRET and a Supabase Edge API configured with E2E_ADMIN_SECRET')
  }
  if (args.tradeAccept && (!state?.password || !Array.isArray(state.users) || state.users.length < 2)) {
    throw new Error('E2E_ENABLE_TRADE_ACCEPT=1 requires tests/e2e-state.json from npm run e2e:seed with at least 2 users')
  }
  if (args.tradeAccept && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_TRADE_ACCEPT=1 requires E2E_ADMIN_SECRET and a Supabase Edge API configured with E2E_ADMIN_SECRET')
  }
  if (args.rookieDraft && (!state?.password || !Array.isArray(state.users) || state.users.length < 4)) {
    throw new Error('E2E_ENABLE_ROOKIE_DRAFT=1 requires tests/e2e-state.json from npm run e2e:seed with at least 4 users')
  }
  if (args.rookieDraft && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_ROOKIE_DRAFT=1 requires E2E_ADMIN_SECRET and a Supabase Edge API configured with E2E_ADMIN_SECRET')
  }
  if (args.seasonReset && (!state?.password || !Array.isArray(state.users) || state.users.length < 4)) {
    throw new Error('E2E_ENABLE_SEASON_RESET=1 requires tests/e2e-state.json from npm run e2e:seed with at least 4 users')
  }
  if (args.seasonReset && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_SEASON_RESET=1 requires E2E_ADMIN_SECRET and a Supabase Edge API configured with E2E_ADMIN_SECRET')
  }
  if (args.midlifeMigration && (!Number.isInteger(MIDLIFE_MIGRATION_AFTER_SEASON) || MIDLIFE_MIGRATION_AFTER_SEASON < 1)) {
    throw new Error('E2E_ENABLE_MIDLIFE_MIGRATION=1 requires a positive integer E2E_MIDLIFE_MIGRATION_AFTER_SEASON')
  }
  if (args.midlifeMigration && args.seasons <= MIDLIFE_MIGRATION_AFTER_SEASON) {
    throw new Error(`E2E_ENABLE_MIDLIFE_MIGRATION=1 requires --seasons>${MIDLIFE_MIGRATION_AFTER_SEASON}`)
  }

  const startedAt = timestamp()
  const rows = []
  const notes = [
    'This harness is integration/E2E only. It does not run unit tests.',
    `Configured API base: ${describeEndpoint(env.apiBaseUrl)}`,
    `Configured frontend: ${describeEndpoint(env.frontendUrl)}`,
    targetLeagueId
      ? `Target league: ${targetLeagueId}${state?.runId ? ` (seed run ${state.runId})` : ''}`
      : 'No target league was configured; invariants will scan all leagues in the configured Supabase project.',
    env.backendTicksEnabled
      ? 'Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.'
      : 'Backend tick endpoints were not enabled; set E2E_ENABLE_BACKEND_TICKS=1 with a local backend to run them.',
    args.repeatScenariosEverySeason
      ? 'One-time scenario slices repeat every simulated season through E2E_REPEAT_SCENARIOS_EVERY_SEASON=1.'
      : 'One-time scenario slices run in season 1 only; set E2E_REPEAT_SCENARIOS_EVERY_SEASON=1 to repeat them every simulated season.',
    args.browser
      ? `Browser smoke enabled through E2E_ENABLE_BROWSER=1${args.browserFullSweep ? ' with full route sweep.' : '.'}`
      : 'Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.',
    args.browserAuth
      ? 'Browser auth scenario enabled through E2E_ENABLE_BROWSER_AUTH=1.'
      : 'Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.',
    args.browserPerf
      ? 'Browser perf smoke enabled through E2E_ENABLE_BROWSER_PERF=1.'
      : 'Browser perf smoke disabled; set E2E_ENABLE_BROWSER_PERF=1 to exercise D.X.4 under continuous auction and live-score mutations.',
    args.browserGameplay
      ? 'Browser gameplay scenario enabled through E2E_ENABLE_BROWSER_GAMEPLAY=1.'
      : 'Browser gameplay scenario disabled; set E2E_ENABLE_BROWSER_GAMEPLAY=1 to exercise the D.SET.4 auction bid UI slice.',
    args.browserLineup
      ? 'Browser lineup scenario enabled through E2E_ENABLE_BROWSER_LINEUP=1.'
      : 'Browser lineup scenario disabled; set E2E_ENABLE_BROWSER_LINEUP=1 to exercise manual lineup setting.',
    args.browserLineupAutoSet
      ? 'Browser lineup auto-set scenario enabled through E2E_ENABLE_BROWSER_LINEUP_AUTO_SET=1.'
      : 'Browser lineup auto-set scenario disabled; set E2E_ENABLE_BROWSER_LINEUP_AUTO_SET=1 to exercise auto-set lineup setting.',
    args.browserLineupLocked
      ? 'Browser lineup locked-player scenario enabled through E2E_ENABLE_BROWSER_LINEUP_LOCKED=1.'
      : 'Browser lineup locked-player scenario disabled; set E2E_ENABLE_BROWSER_LINEUP_LOCKED=1 to exercise locked-player move blocking.',
    args.browserPlayoff
      ? 'Browser playoff champion scenario enabled through E2E_ENABLE_BROWSER_PLAYOFF=1.'
      : 'Browser playoff champion scenario disabled; set E2E_ENABLE_BROWSER_PLAYOFF=1 to exercise the D.SEA.4 champion bracket UI slice.',
    args.browserRookieDraft
      ? 'Browser rookie draft auto-pick scenario enabled through E2E_ENABLE_BROWSER_ROOKIE_DRAFT=1.'
      : 'Browser rookie draft auto-pick scenario disabled; set E2E_ENABLE_BROWSER_ROOKIE_DRAFT=1 to exercise the D.SEA.5 30-second timer slice.',
    args.browserWaiver
      ? 'Browser waiver scenario enabled through E2E_ENABLE_BROWSER_WAIVER=1.'
      : 'Browser waiver scenario disabled; set E2E_ENABLE_BROWSER_WAIVER=1 to exercise the D.SEA.2 waiver claim UI slice.',
    args.browserWaiverDrop
      ? 'Browser waiver drop scenario enabled through E2E_ENABLE_BROWSER_WAIVER_DROP=1.'
      : 'Browser waiver drop scenario disabled; set E2E_ENABLE_BROWSER_WAIVER_DROP=1 to exercise the D.SEA.2 drop-then-add waiver claim UI slice.',
    args.browserWaiverIrBlock
      ? 'Browser waiver IR-block scenario enabled through E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK=1.'
      : 'Browser waiver IR-block scenario disabled; set E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK=1 to exercise DTD-on-IR claim blocking.',
    args.browserTrade
      ? 'Browser trade proposal scenario enabled through E2E_ENABLE_BROWSER_TRADE=1.'
      : 'Browser trade proposal scenario disabled; set E2E_ENABLE_BROWSER_TRADE=1 to exercise the D.SEA.2 trade proposal UI slice.',
    args.browserTradeAccept
      ? 'Browser trade accept scenario enabled through E2E_ENABLE_BROWSER_TRADE_ACCEPT=1.'
      : 'Browser trade accept scenario disabled; set E2E_ENABLE_BROWSER_TRADE_ACCEPT=1 to exercise the D.SEA.2 trade accept UI slice.',
    args.browserTradeTerminal
      ? 'Browser trade reject/withdraw scenario enabled through E2E_ENABLE_BROWSER_TRADE_TERMINAL=1.'
      : 'Browser trade reject/withdraw scenario disabled; set E2E_ENABLE_BROWSER_TRADE_TERMINAL=1 to exercise the D.SEA.2 trade terminal-action UI slice.',
    args.browserTradeFuturePick
      ? 'Browser future-pick trade scenario enabled through E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK=1.'
      : 'Browser future-pick trade scenario disabled; set E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK=1 to exercise the D.SEA.2 future-pick proposal UI slice.',
    args.browserTradeFuturePickAccept
      ? 'Browser future-pick trade accept scenario enabled through E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT=1.'
      : 'Browser future-pick trade accept scenario disabled; set E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT=1 to exercise the D.SEA.2 future-pick accept UI slice.',
    args.browserTradeOverflowAccept
      ? 'Browser trade overflow accept scenario enabled through E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT=1.'
      : 'Browser trade overflow accept scenario disabled; set E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT=1 to exercise the D.SEA.2 drop-before-accept UI slice.',
    args.browserTradePostDeadline
      ? 'Browser post-deadline trade scenario enabled through E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE=1.'
      : 'Browser post-deadline trade scenario disabled; set E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE=1 to exercise the D.SEA.2 trade-deadline rejection slice.',
    args.browserTradeVeto
      ? 'Browser trade veto scenario enabled through E2E_ENABLE_BROWSER_TRADE_VETO=1.'
      : 'Browser trade veto scenario disabled; set E2E_ENABLE_BROWSER_TRADE_VETO=1 to exercise the D.SEA.2 accepted-state veto UI slice.',
    args.browserLeagueLifecycle
      ? 'Browser league create/join lifecycle scenario enabled through E2E_ENABLE_BROWSER_LEAGUE_LIFECYCLE=1.'
      : 'Browser league create/join lifecycle scenario disabled; set E2E_ENABLE_BROWSER_LEAGUE_LIFECYCLE=1 to exercise D.SET.2 through the real Expo forms.',
    args.leagueLifecycle
      ? 'League create/join lifecycle scenario enabled through E2E_ENABLE_LEAGUE_LIFECYCLE=1.'
      : 'League create/join lifecycle scenario disabled; set E2E_ENABLE_LEAGUE_LIFECYCLE=1 to exercise D.SET.2 through real auth RPCs.',
    args.pickChain
      ? 'Future-pick multi-hop scenario enabled through E2E_ENABLE_PICK_CHAIN=1.'
      : 'Future-pick multi-hop scenario disabled; set E2E_ENABLE_PICK_CHAIN=1 to exercise D.LONG.2.',
    args.push
      ? 'Push notification intercept enabled through E2E_ENABLE_PUSH=1.'
      : 'Push notification intercept disabled; set E2E_ENABLE_PUSH=1 with backend EXPO_PUSH_URL pointed at the fake upstream to exercise the trade-notification slice of D.X.1.',
    args.draftPush
      ? 'Draft push notification intercept enabled through E2E_ENABLE_DRAFT_PUSH=1.'
      : 'Draft push notification intercept disabled; set E2E_ENABLE_DRAFT_PUSH=1 to exercise the rookie auto-pick notification slice of D.X.1.',
    args.history
      ? 'Standings/champion history retention enabled through E2E_ENABLE_HISTORY=1.'
      : 'Standings/champion history retention disabled; set E2E_ENABLE_HISTORY=1 with Edge E2E ticks to exercise the D.LONG.3/D.LONG.4 fixture-retention slice.',
    args.realtime
      ? `Realtime latency check enabled through E2E_ENABLE_REALTIME=1 for ${REALTIME_CLIENTS} clients.`
      : 'Realtime latency check disabled; set E2E_ENABLE_REALTIME=1 to exercise the D.X.2 matchup and auction bid update slice.',
    args.midlifeMigration
      ? `Mid-life migration check enabled after season ${MIDLIFE_MIGRATION_AFTER_SEASON}.`
      : 'Mid-life migration check disabled; set E2E_ENABLE_MIDLIFE_MIGRATION=1 to exercise D.LONG.5.',
    args.auction
      ? 'Auction bid validation enabled through E2E_ENABLE_AUCTION=1.'
      : 'Auction validation disabled; set E2E_ENABLE_AUCTION=1 to exercise the D.SET.4 server-side bid validation slice.',
    args.playoffs
      ? 'Playoff bracket scenario enabled through E2E_ENABLE_PLAYOFFS=1.'
      : 'Playoff bracket scenario disabled; set E2E_ENABLE_PLAYOFFS=1 to exercise the D.SEA.4 top-6 bracket slice.',
    args.tiebreakers
      ? 'Standings tiebreaker scenario enabled through E2E_ENABLE_TIEBREAKERS=1.'
      : 'Standings tiebreaker scenario disabled; set E2E_ENABLE_TIEBREAKERS=1 to exercise D.SEA.3.',
    args.settings
      ? 'Commissioner settings propagation scenario enabled through E2E_ENABLE_SETTINGS=1.'
      : 'Commissioner settings propagation scenario disabled; set E2E_ENABLE_SETTINGS=1 to exercise D.SET.3.',
    args.scoring
      ? 'Weekly starter-only scoring/finalization scenario enabled through E2E_ENABLE_SCORING=1.'
      : 'Weekly starter-only scoring/finalization scenario disabled; set E2E_ENABLE_SCORING=1 to exercise the D.SEA.2 scoring slice.',
    args.waiverProcessing
      ? 'Waiver priority/daily processing scenario enabled through E2E_ENABLE_WAIVER_PROCESSING=1.'
      : 'Waiver priority/daily processing scenario disabled; set E2E_ENABLE_WAIVER_PROCESSING=1 to exercise priority, drop, failed_roster, and daily processing.',
    args.tradeVeto
      ? 'Trade veto threshold scenario enabled through E2E_ENABLE_TRADE_VETO=1.'
      : 'Trade veto threshold scenario disabled; set E2E_ENABLE_TRADE_VETO=1 to exercise the D.SEA.2 veto-window slice.',
    args.injuryFilter
      ? 'Sleeper injury-status filter scenario enabled through E2E_ENABLE_INJURY_FILTER=1.'
      : 'Sleeper injury-status filter scenario disabled; set E2E_ENABLE_INJURY_FILTER=1 to exercise the D.SEA.2 injury injection slice.',
    args.tradeAccept
      ? 'Trade acceptance atomicity scenario enabled through E2E_ENABLE_TRADE_ACCEPT=1.'
      : 'Trade acceptance atomicity scenario disabled; set E2E_ENABLE_TRADE_ACCEPT=1 to exercise the D.SEA.2 multi-asset trade slice.',
    args.rookieDraft
      ? 'Rookie draft auto-pick/order scenario enabled through E2E_ENABLE_ROOKIE_DRAFT=1.'
      : 'Rookie draft auto-pick/order scenario disabled; set E2E_ENABLE_ROOKIE_DRAFT=1 to exercise the D.SEA.5 auto-pick slice.',
    args.seasonReset
      ? 'Season reset carryover/reseed scenario enabled through E2E_ENABLE_SEASON_RESET=1.'
      : 'Season reset carryover/reseed scenario disabled; set E2E_ENABLE_SEASON_RESET=1 to exercise the D.SEA.6 reset slice.',
  ]

  try {
    const supabase = createClient(
      env.supabaseUrl,
      env.serviceRoleKey,
      { auth: { persistSession: false } },
    )
    const schemaFailures = await runSchemaPreflight(supabase)
    if (schemaFailures.length > 0) {
      await writeReport({
        status: 'BLOCKED',
        startedAt,
        finishedAt: timestamp(),
        seasons: args.seasons,
        rows: [{ season: 0, status: 'BLOCKED', notes: `Schema preflight failed: ${schemaFailures.join('; ')}` }],
        notes: [
          ...notes,
          'Apply the post-refactor Supabase migrations before running the multi-season soak.',
        ],
      })
      await writeCoverageReport({
        status: 'BLOCKED',
        startedAt,
        finishedAt: timestamp(),
        seasons: args.seasons,
        args,
        env,
        targetLeagueId,
        rows: [{ season: 0, status: 'BLOCKED', notes: `Schema preflight failed: ${schemaFailures.join('; ')}` }],
        notes: [
          ...notes,
          'Apply the post-refactor Supabase migrations before running the multi-season soak.',
        ],
      })
      process.exitCode = 1
      return
    }
    notes.push('Schema preflight passed: post-refactor RPCs and required columns are present.')
    const scenarios = {}
    if (args.history) {
      scenarios.historyFixtures = []
    }
    if (args.pickChain) {
      scenarios.futurePickChain = await setupFuturePickChain(supabase, targetLeagueId)
      await mkdir(ARTIFACT_ROOT, { recursive: true })
      await writeFile(
        path.join(ARTIFACT_ROOT, 'future-pick-chain.json'),
        `${JSON.stringify(scenarios.futurePickChain, null, 2)}\n`,
      )
      notes.push(
        `Future-pick chain: ${scenarios.futurePickChain.targetYear} round 1 pick ${scenarios.futurePickChain.targetPickId} now belongs to ${scenarios.futurePickChain.finalOwnerTeam}.`,
      )
    }

    const fake = createFakeUpstreamServer()
    await fake.listen(args.fakePort)

    try {
      if (env.backendTicksEnabled) {
        await backendGetJson(env, '/e2e/status')
        await assertCorsPreflight(env)
        notes.push('CORS preflight check passed for the configured frontend origin.')
      }
      if (args.push || args.draftPush) {
        await assertBackendUsesFakePush(env, args.fakePort)
        notes.push('Backend EXPO_PUSH_URL points at the fake upstream push intercept.')
      }

      let previousSnapshot = null
      const perfMetrics = []
      for (let season = 1; season <= args.seasons; season += 1) {
        let midlifeMigrationReport = null
        if (args.midlifeMigration && season === MIDLIFE_MIGRATION_AFTER_SEASON + 1) {
          midlifeMigrationReport = await applyMidlifeMigration(season)
          notes.push(`D.LONG.5 mid-life migration ${midlifeMigrationReport.status.toLowerCase()} before season ${season}.`)
        }

        const seasonStartedMs = nowMs()
        await mkdir(path.join(ARTIFACT_ROOT, `season-${season}`), { recursive: true })
        await postJson(`http://127.0.0.1:${args.fakePort}/admin/now`, {
          now: `${2026 + season}-10-20T12:00:00.000Z`,
        })

        if (env.backendTicksEnabled) {
          await backendJson(env, '/e2e/sync-schedule')
          await backendJson(env, '/e2e/sync-players')
          await backendJson(env, '/e2e/live-poll', {
            date: `${2026 + season}-10-20T12:00:00.000Z`,
            leagueId: targetLeagueId,
          })
          await backendJson(env, '/e2e/process-waivers')
          await backendJson(env, '/e2e/generate-matchups', { force: false, leagueId: targetLeagueId })
        }

        const {
          browserCheck,
          browserAuthCheck,
          browserPerfCheck,
          browserGameplayCheck,
          browserLineupCheck,
          browserLineupAutoSetCheck,
          browserLineupLockedCheck,
          browserPlayoffCheck,
          browserRookieDraftCheck,
          browserWaiverCheck,
          browserWaiverDropCheck,
          browserWaiverIrBlockCheck,
          browserTradeCheck,
          browserTradeAcceptCheck,
          browserTradeTerminalCheck,
          browserTradeFuturePickCheck,
          browserTradeFuturePickAcceptCheck,
          browserTradeOverflowAcceptCheck,
          browserTradePostDeadlineCheck,
          browserTradeVetoCheck,
          browserTradeMultiTeamCheck,
          browserLeagueLifecycleCheck,
        } = await runBrowserScenarios({ args, season, shouldRun: shouldRunScenario })
        const backendScenarioResults = await runBackendScenarios({
          args,
          shouldRun: shouldRunScenario,
          context: {
            supabase,
            env,
            state,
            season,
            leagueId: targetLeagueId,
            fakePort: args.fakePort,
          },
          runners: {
            assertAuctionBidValidation,
            assertCommissionerSettingsScenario,
            assertDraftPushNotification,
            assertInjuryStatusFilterScenario,
            assertLeagueLifecycleScenario,
            assertPlayoffBracketScenario,
            assertRookieDraftAutoPickScenario,
            assertSeasonResetScenario,
            assertStandingsTiebreakerScenario,
            assertTradeAcceptanceAtomicityScenario,
            assertTradeVetoScenario,
            assertWaiverProcessingScenario,
            assertWeeklyScoringFinalizationScenario,
          },
        })
        const {
          auctionValidation,
          draftPushCheck,
          injuryFilterCheck,
          leagueLifecycleCheck,
          playoffCheck,
          rookieDraftCheck,
          scoringCheck,
          seasonResetCheck,
          settingsCheck,
          tiebreakerCheck,
          tradeAcceptCheck,
          tradeVetoCheck,
          waiverProcessingCheck,
        } = backendScenarioResults
        let realtimeCheck = false
        if (args.realtime) {
          await assertRealtimeDelivery({
            supabase,
            env,
            state,
            leagueId: targetLeagueId,
            season,
          })
          realtimeCheck = true
        }
        let pushCheck = false
        if (args.push) {
          await assertPushNotifications({
            supabase,
            env,
            state,
            leagueId: targetLeagueId,
            season,
            fakePort: args.fakePort,
          })
          pushCheck = true
        }

        if (env.backendTicksEnabled) {
          await backendJson(env, '/e2e/close-expired-nominations')
          await backendJson(env, '/e2e/process-trades')
          await backendJson(env, '/e2e/process-waivers')
        }
        const failuresAtStart = await runInvariants(supabase, targetLeagueId, scenarios)
        if (env.backendTicksEnabled) {
          await backendJson(env, '/e2e/close-expired-nominations')
        }
        const failuresAtEnd = await runInvariants(supabase, targetLeagueId, scenarios)
        const matchupFailures = env.backendTicksEnabled
          ? await assertMatchupGenerationIdempotent(supabase, env, targetLeagueId)
          : []
        const failuresAfterReset = []
        let rookieDraftPickChainCheck = null
        let historyCheck = null
        if (env.backendTicksEnabled) {
          if (args.history) {
            const currentSeasonForHistory = await fetchSingle(
              supabase,
              'league_seasons',
              'id, season_year',
              { league_id: targetLeagueId, is_current: true },
            )
            const fixture = await ensureHistoryFixtureForSeason(supabase, targetLeagueId, currentSeasonForHistory)
            if (!scenarios.historyFixtures.some((existing) => existing.leagueSeasonId === fixture.leagueSeasonId)) {
              scenarios.historyFixtures.push(fixture)
            }
          }
          const { error: targetStatusError } = await supabase
            .from('leagues')
            .update({ status: 'playoffs' })
            .eq('id', targetLeagueId)
          if (targetStatusError) throw new Error(`D.SEA.6 target playoff status staging failed: ${targetStatusError.message}`)
          await backendJson(env, '/e2e/advance-season', { leagueId: targetLeagueId })
          failuresAfterReset.push(...await runInvariants(supabase, targetLeagueId, scenarios))
          if (args.history) {
            const historyFailures = await assertHistoryRetained(supabase, scenarios.historyFixtures, season)
            failuresAfterReset.push(...historyFailures)
            if (historyFailures.length === 0) historyCheck = true
          }
          if (scenarios.futurePickChain) {
            rookieDraftPickChainCheck = await assertFuturePickMaterializedInRookieDraft(
              supabase,
              env,
              targetLeagueId,
              scenarios.futurePickChain,
              season,
            )
          }
        }
        const snapshot = await writeSnapshots(supabase, season, targetLeagueId)
        const hadPreviousSnapshot = previousSnapshot != null
        const snapshotFailures = validateSnapshotProgress(previousSnapshot, snapshot, {
          expectResetGrowth: env.backendTicksEnabled,
        })
        previousSnapshot = snapshot
        const durationMs = nowMs() - seasonStartedMs
        perfMetrics.push({ season, durationMs: roundedMs(durationMs), memory: currentMemory() })
        await mkdir(ARTIFACT_ROOT, { recursive: true })
        await writeFile(PERF_METRICS_PATH, `${JSON.stringify({
          runtimeDriftLimit: PERF_DRIFT_LIMIT,
          memoryDriftLimit: MEMORY_DRIFT_LIMIT,
          memoryDriftMinBytes: MEMORY_DRIFT_MIN_BYTES,
          memoryHeapDriftMinBytes: MEMORY_HEAP_DRIFT_MIN_BYTES,
          metrics: perfMetrics,
        }, null, 2)}\n`)
        const perfFailures = validatePerfDrift(perfMetrics, args.seasons)
        const memoryFailures = validateMemoryDrift(perfMetrics, args.seasons)
        const failures = [
          ...failuresAtStart,
          ...failuresAtEnd,
          ...matchupFailures,
          ...failuresAfterReset,
          ...snapshotFailures,
          ...backendScenarioFailures(backendScenarioResults),
          ...perfFailures,
          ...memoryFailures,
        ]

        if (failures.length > 0) {
          rows.push({ season, status: 'FAIL', notes: failures.join('; ') })
          if (!args.keepGoing) break
        } else {
          const seasonNotes = env.backendTicksEnabled
            ? 'D.0 invariant boundary checks passed before and after real season reset; enabled scenario slices passed'
            : 'D.0 invariant boundary checks passed; enabled scenario slices passed'
          rows.push({
            season,
            status: 'PASS',
            evidenceIds: [
              'invariants.boundary',
              browserCheck ? 'browser.smoke' : null,
              browserAuthCheck ? 'browser.auth' : null,
              browserPerfCheck ? 'browser.performance' : null,
              browserGameplayCheck ? 'browser.auction' : null,
              browserLineupCheck ? 'browser.lineup' : null,
              browserLineupAutoSetCheck ? 'browser.lineup_auto_set' : null,
              browserLineupLockedCheck ? 'browser.lineup_locked' : null,
              browserPlayoffCheck ? 'browser.playoffs' : null,
              browserRookieDraftCheck ? 'browser.rookie_draft' : null,
              browserWaiverCheck ? 'browser.waiver' : null,
              browserWaiverDropCheck ? 'browser.waiver_drop' : null,
              browserWaiverIrBlockCheck ? 'browser.waiver_ir_block' : null,
              browserTradeCheck ? 'browser.trade_proposal' : null,
              browserTradeAcceptCheck ? 'browser.trade_accept' : null,
              browserTradeTerminalCheck ? 'browser.trade_terminal' : null,
              browserTradeFuturePickCheck ? 'browser.trade_future_pick' : null,
              browserTradeFuturePickAcceptCheck ? 'browser.trade_future_pick_accept' : null,
              browserTradeOverflowAcceptCheck ? 'browser.trade_overflow_accept' : null,
              browserTradePostDeadlineCheck ? 'browser.trade_post_deadline' : null,
              browserTradeVetoCheck ? 'browser.trade_veto' : null,
              browserTradeMultiTeamCheck ? 'browser.trade_multi_team' : null,
              browserLeagueLifecycleCheck ? 'browser.league_lifecycle' : null,
              leagueLifecycleCheck ? 'backend.league_lifecycle' : null,
              realtimeCheck ? 'realtime.delivery' : null,
              pushCheck ? 'push.trade_waiver' : null,
              draftPushCheck ? 'push.draft' : null,
              midlifeMigrationReport ? 'migration.midlife' : null,
              auctionValidation ? 'backend.auction' : null,
              playoffCheck ? 'backend.playoffs' : null,
              tiebreakerCheck ? 'backend.tiebreakers' : null,
              settingsCheck ? 'backend.settings' : null,
              scoringCheck ? 'backend.scoring' : null,
              waiverProcessingCheck ? 'backend.waiver_processing' : null,
              injuryFilterCheck ? 'backend.injury_filter' : null,
              tradeAcceptCheck ? 'backend.trade_accept' : null,
              tradeVetoCheck ? 'backend.trade_veto' : null,
              rookieDraftCheck ? 'backend.rookie_draft' : null,
              seasonResetCheck ? 'backend.season_reset' : null,
              env.backendTicksEnabled ? 'matchups.idempotent' : null,
              args.pickChain ? 'picks.long_horizon' : null,
              rookieDraftPickChainCheck ? 'picks.rookie_materialization' : null,
              historyCheck ? 'history.retained' : null,
              hadPreviousSnapshot ? 'snapshots.no_shrink' : null,
              args.seasons >= 10 && season >= 10 ? 'runtime.drift' : null,
              args.seasons >= 10 && season >= 10 ? 'memory.drift' : null,
            ].filter(Boolean),
            notes: [
              seasonNotes,
              args.browser ? 'browser smoke passed' : null,
              args.browserAuth ? 'browser auth scenario passed' : null,
              browserPerfCheck ? 'browser perf smoke passed' : null,
              browserGameplayCheck ? 'browser auction bid gameplay passed' : null,
              browserLineupCheck ? 'browser lineup gameplay passed' : null,
              browserLineupAutoSetCheck ? 'browser lineup auto-set gameplay passed' : null,
              browserLineupLockedCheck ? 'browser lineup locked gameplay passed' : null,
              browserPlayoffCheck ? 'browser playoff champion passed' : null,
              browserRookieDraftCheck ? 'browser rookie draft auto-pick passed' : null,
              browserWaiverCheck ? 'browser waiver claim gameplay passed' : null,
              browserWaiverDropCheck ? 'browser waiver drop claim gameplay passed' : null,
              browserWaiverIrBlockCheck ? 'browser waiver IR block gameplay passed' : null,
              waiverProcessingCheck ? 'waiver priority processing passed' : null,
              browserTradeCheck ? 'browser trade proposal gameplay passed' : null,
              browserTradeAcceptCheck ? 'browser trade accept gameplay passed' : null,
              browserTradeTerminalCheck ? 'browser trade reject/withdraw gameplay passed' : null,
              browserTradeFuturePickCheck ? 'browser future-pick trade gameplay passed' : null,
              browserTradeFuturePickAcceptCheck ? 'browser future-pick trade accept gameplay passed' : null,
              browserTradeOverflowAcceptCheck ? 'browser trade overflow accept gameplay passed' : null,
              browserTradePostDeadlineCheck ? 'browser post-deadline trade gameplay passed' : null,
              browserTradeVetoCheck ? 'browser trade veto gameplay passed' : null,
              browserTradeMultiTeamCheck ? 'browser multi-team trade gameplay passed' : null,
              browserLeagueLifecycleCheck ? 'browser league lifecycle passed' : null,
              leagueLifecycleCheck ? 'league lifecycle passed' : null,
              args.realtime ? 'realtime matchup and bid updates delivered' : null,
              args.push ? 'trade and waiver push notification intercepts passed' : null,
              draftPushCheck ? 'draft push notification intercept passed' : null,
              midlifeMigrationReport ? `mid-life migration applied (${midlifeMigrationReport.status})` : null,
              auctionValidation ? 'auction bid validation passed' : null,
              playoffCheck ? 'playoff bracket scenario passed' : null,
              tiebreakerCheck ? 'standings tiebreaker scenario passed' : null,
              settingsCheck ? 'commissioner settings propagation passed' : null,
              scoringCheck ? 'weekly scoring finalization passed' : null,
              injuryFilterCheck ? 'injury status filter passed' : null,
              tradeAcceptCheck ? 'trade acceptance atomicity passed' : null,
              tradeVetoCheck ? 'trade veto threshold passed' : null,
              rookieDraftCheck ? 'rookie draft auto-pick passed' : null,
              seasonResetCheck ? 'season reset carryover passed' : null,
              env.backendTicksEnabled ? 'matchup generation idempotency passed' : null,
              args.pickChain ? 'multi-hop future-pick owner resolved' : null,
              rookieDraftPickChainCheck ? 'rookie draft traded-pick slot resolved' : null,
              historyCheck ? 'standings/champion history retained' : null,
              hadPreviousSnapshot ? 'snapshot row-count diff passed' : null,
              args.seasons >= 10 && season >= 10 ? 'runtime drift check passed' : null,
              args.seasons >= 10 && season >= 10 ? 'harness memory drift check passed' : null,
            ].filter(Boolean).join('; '),
          })
        }

        await postJson(`http://127.0.0.1:${args.fakePort}/admin/advance-season`, {})
      }
    } finally {
      await fake.close()
    }

    if (rows.length > 0) {
      notes.push(`Perf metrics written to ${path.relative(ROOT, PERF_METRICS_PATH)}.`)
    }

    const status = rows.some((row) => row.status === 'FAIL')
      ? 'FAIL'
      : rows.length === args.seasons && rows.every((row) => row.status === 'PASS')
        ? 'PASS'
        : 'PARTIAL'
    await writeReport({
      status,
      startedAt,
      finishedAt: timestamp(),
      seasons: args.seasons,
      rows,
      notes,
    })
    const coverage = await writeCoverageReport({
      status,
      startedAt,
      finishedAt: timestamp(),
      seasons: args.seasons,
      args,
      env,
      targetLeagueId,
      rows,
      notes,
    })

    if (status !== 'PASS' || (args.releaseGate && coverage.status !== 'PASS')) process.exitCode = 1
  } catch (error) {
    const finishedAt = timestamp()
    const errorRows = [{ season: 0, status: 'ERROR', notes: errorMessage(error) }]
    const errorNotes = [
      ...notes,
      'The soak runner failed before completing the requested season loop.',
    ]
    await writeReport({
      status: 'ERROR',
      startedAt,
      finishedAt,
      seasons: args.seasons,
      rows: errorRows,
      notes: errorNotes,
    })
    await writeCoverageReport({
      status: 'ERROR',
      startedAt,
      finishedAt,
      seasons: args.seasons,
      args,
      env,
      targetLeagueId,
      rows: errorRows,
      notes: errorNotes,
    })
    if (error instanceof Error) {
      throw Object.assign(error, { e2eReportWritten: true })
    }
    throw Object.assign(new Error(String(error)), { e2eReportWritten: true })
  }
}

main().catch(async (error) => {
  const reportWritten = typeof error === 'object' && error !== null && 'e2eReportWritten' in error
  if (!reportWritten && !errorMessage(error).startsWith('Missing required soak environment:')) {
    const now = timestamp()
    await writeReport({
      status: 'ERROR',
      startedAt: now,
      finishedAt: now,
      seasons: Number(process.env.E2E_SEASONS ?? 10),
      rows: [{ season: 0, status: 'ERROR', notes: errorMessage(error) }],
      notes: ['The soak runner failed before completing the requested season loop.'],
    })
  }
  console.error(error)
  process.exitCode = 1
})

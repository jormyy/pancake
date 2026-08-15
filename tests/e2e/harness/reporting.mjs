import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BROWSER_SCENARIO_MANIFEST as BROWSER_SCENARIOS } from '../browser-scenario-manifest.mjs'
import { BACKEND_SCENARIO_MANIFEST as BACKEND_SCENARIOS } from '../backend-scenario-manifest.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-report.md')
const COVERAGE_PATH = path.join(ROOT, 'tests/e2e-coverage.md')

/** @typedef {{ season: number, status: string, notes: string, evidenceIds?: string[] }} SoakRow */
/** @typedef {{ status: string, startedAt: string, finishedAt: string, seasons: number, rows: SoakRow[], notes: string[] }} ReportInput */
/**
 * @typedef {{
 *   auction: boolean, browser: boolean, browserAuth: boolean, browserFullSweep: boolean,
 *   browserGameplay: boolean, browserLeagueLifecycle: boolean, browserLineup: boolean,
 *   browserLineupAutoSet: boolean, browserLineupLocked: boolean, browserPerf: boolean,
 *   browserPlayoff: boolean, browserRookieDraft: boolean, browserTrade: boolean,
 *   browserTradeAccept: boolean, browserTradeFuturePick: boolean,
 *   browserTradeFuturePickAccept: boolean, browserTradeOverflowAccept: boolean,
 *   browserTradePostDeadline: boolean, browserTradeTerminal: boolean, browserTradeVeto: boolean,
 *   browserTradeMultiTeam: boolean,
 *   browserWaiver: boolean, browserWaiverDrop: boolean, browserWaiverIrBlock: boolean,
 *   draftPush: boolean, fakePort: number, history: boolean, injuryFilter: boolean,
 *   leagueLifecycle: boolean, midlifeMigration: boolean, pickChain: boolean, playoffs: boolean,
 *   push: boolean, realtime: boolean, rookieDraft: boolean, scoring: boolean,
 *   offseasonActivity: boolean, seasonReset: boolean, settings: boolean, tiebreakers: boolean, tradeAccept: boolean,
 *   tradeVeto: boolean, waiverProcessing: boolean
 * }} CoverageArgs
 */
/** @typedef {ReportInput & { args: CoverageArgs, env: { backendTicksEnabled: boolean, serviceRoleKey?: string, supabaseUrl?: string }, targetLeagueId: string | null }} CoverageInput */

/** @param {ReportInput} input */
export const writeReport = async ({ status, startedAt, finishedAt, seasons, rows, notes }) => {
  const lines = [
    '# Multi-Season E2E Soak Report',
    '',
    `- Status: ${status}`,
    `- Started: ${startedAt}`,
    `- Finished: ${finishedAt}`,
    `- Target seasons: ${seasons}`,
    `- Fake upstream: http://127.0.0.1:${process.env.FAKE_UPSTREAM_PORT ?? 4555}`,
    '',
    '## Season Summary',
    '',
    '| Season | Status | Notes |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.season} | ${row.status} | ${row.notes.replaceAll('\n', '<br>')} |`),
    '',
    '## Notes',
    '',
    ...notes.map((note) => `- ${note}`),
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`)
}

/** @param {SoakRow[]} rows @param {string} evidenceId */
const hasEvidence = (rows, evidenceId) => rows.some((row) => row.status === 'PASS' && row.evidenceIds?.includes(evidenceId))
/** @param {SoakRow[]} rows @param {boolean} runFailed @param {boolean} enabled @param {string} evidenceId */
export const evidenceStatusForRows = (rows, runFailed, enabled, evidenceId) => !enabled
  ? 'PENDING'
  : hasEvidence(rows, evidenceId) ? 'PASS' : runFailed ? 'FAIL' : 'PENDING'
/** @param {string} status */
const hasEvidencePass = (status) => status === 'PASS'
/** @param {boolean} enabled @param {string} status */
const hasEnabledEvidencePass = (enabled, status) => enabled && hasEvidencePass(status)
/** @param {{ enabled: boolean, status: string }[]} items */
const allEnabledEvidencePass = (items) => items.every(({ enabled, status }) => enabled && hasEvidencePass(status))
/** @param {{ id: string, status: string, requiredForRelease: boolean }[]} coverage */
export const productionCoverageStatus = (coverage) => {
  const prerequisiteStatuses = coverage
    .filter((row) => row.requiredForRelease)
    .map((row) => row.status)
  if (prerequisiteStatuses.length === 0) return 'PENDING'
  return prerequisiteStatuses.every((item) => item === 'PASS')
    ? 'PASS'
    : prerequisiteStatuses.some((item) => item === 'FAIL' || item === 'BLOCKED') ? 'FAIL' : 'PENDING'
}
/** @param {CoverageInput} input */
export const writeCoverageReport = async ({ status, startedAt, finishedAt, seasons, args, env, targetLeagueId, rows, notes }) => {
  const auditExists = await readFile(path.join(ROOT, 'tests/audit-report.md'), 'utf8')
    .then(() => true)
    .catch(() => false)
  const rowStatus = rows.some((row) => row.status === 'FAIL' || row.status === 'ERROR' || row.status === 'BLOCKED')
    ? 'FAIL'
    : rows.length > 0 ? 'PARTIAL' : 'PENDING'
  const producedTenSeasons = rows.some((row) => Number(row.season) >= 10)
  const runFailed = status === 'ERROR' || rowStatus === 'FAIL'
  /** @param {boolean} enabled @param {string} evidenceId */
  const evidenceStatus = (enabled, evidenceId) => evidenceStatusForRows(rows, runFailed, enabled, evidenceId)
  const invariantStatus = evidenceStatus(rows.length > 0, 'invariants.boundary')
  const runtimeStatus = evidenceStatus(producedTenSeasons, 'runtime.drift')
  const memoryStatus = evidenceStatus(producedTenSeasons, 'memory.drift')
  const resetStatus = args.seasonReset
    ? evidenceStatus(true, 'backend.season_reset')
    : env.backendTicksEnabled
      ? runFailed ? 'FAIL' : 'PARTIAL'
      : 'PENDING'
  const snapshotStatus = evidenceStatus(rows.length > 1, 'snapshots.no_shrink')
  const matchupStatus = evidenceStatus(env.backendTicksEnabled, 'matchups.idempotent')
  const pickChainStatus = evidenceStatus(args.pickChain, 'picks.long_horizon')
  const browserStatusById = new Map(BROWSER_SCENARIOS.map((scenario) => [
    scenario.id,
    evidenceStatus(Boolean(args[scenario.flag]), scenario.evidenceId),
  ]))
  /** @param {string} id */
  const browserScenarioStatus = (id) => browserStatusById.get(id) ?? 'PENDING'
  const backendStatusById = new Map(BACKEND_SCENARIOS.map((scenario) => [
    scenario.id,
    evidenceStatus(Boolean(args[scenario.flag]), scenario.evidenceId),
  ]))
  /** @param {string} id */
  const backendScenarioStatus = (id) => backendStatusById.get(id) ?? 'PENDING'
  const browserSmokeStatus = browserScenarioStatus('smoke')
  const browserAuthStatus = browserScenarioStatus('auth')
  const fakeUpstreamStatus = evidenceStatus(env.backendTicksEnabled, 'environment.fake_upstream')
  const corsStatus = evidenceStatus(env.backendTicksEnabled, 'cross.cors')
  const browserStatus = args.browser && args.browserAuth && args.browserFullSweep
    ? browserSmokeStatus === 'PASS' && browserAuthStatus === 'PASS' ? 'PASS' : runFailed ? 'FAIL' : 'PARTIAL'
    : args.browser || args.browserAuth ? runFailed ? 'FAIL' : 'PARTIAL' : 'PENDING'
  const browserPerfStatus = browserScenarioStatus('performance')
  const browserTradeMultiTeamStatus = browserScenarioStatus('trade-multi-team')
  const leagueLifecyclePassed = backendScenarioStatus('league-lifecycle') === 'PASS'
  const browserLeagueLifecyclePassed = hasEvidence(rows, 'browser.league_lifecycle')
  const leagueLifecycleStatus = args.leagueLifecycle || args.browserLeagueLifecycle
    ? leagueLifecyclePassed && browserLeagueLifecyclePassed
        ? 'PASS'
        : leagueLifecyclePassed || browserLeagueLifecyclePassed
          ? 'PARTIAL'
          : runFailed ? 'FAIL' : 'PENDING'
    : targetLeagueId ? 'PARTIAL' : 'PENDING'
  const tradeWaiverPushPassed = hasEvidence(rows, 'push.trade_waiver')
  const draftPushPassed = hasEvidence(rows, 'push.draft')
  const pushStatus = args.push || args.draftPush
    ? args.push && args.draftPush && tradeWaiverPushPassed && draftPushPassed
        ? 'PASS'
        : tradeWaiverPushPassed || draftPushPassed
          ? 'PARTIAL'
          : runFailed ? 'FAIL' : 'PENDING'
    : 'PENDING'
  const historyStatus = evidenceStatus(args.history, 'history.retained')
  const realtimeStatus = evidenceStatus(args.realtime, 'realtime.delivery')
  const midlifeMigrationStatus = evidenceStatus(args.midlifeMigration, 'migration.midlife')
  const auctionBackendStatus = backendScenarioStatus('auction')
  const auctionBrowserStatus = evidenceStatus(args.browserGameplay, 'browser.auction')
  const auctionStatus = args.auction || args.browserGameplay
    ? args.auction && args.browserGameplay && auctionBackendStatus === 'PASS' && auctionBrowserStatus === 'PASS'
      ? 'PASS' : auctionBackendStatus === 'PASS' || auctionBrowserStatus === 'PASS' ? 'PARTIAL' : runFailed ? 'FAIL' : 'PENDING'
    : 'PENDING'
  const playoffsStatus = backendScenarioStatus('playoffs')
  const browserPlayoffStatus = browserScenarioStatus('playoffs')
  const tiebreakerStatus = backendScenarioStatus('tiebreakers')
  const settingsStatus = backendScenarioStatus('settings')
  const scoringStatus = backendScenarioStatus('scoring')
  const waiverProcessingStatus = backendScenarioStatus('waiver-processing')
  const injuryFilterStatus = backendScenarioStatus('injury-filter')
  const tradeAcceptStatus = backendScenarioStatus('trade-accept')
  const tradeVetoStatus = backendScenarioStatus('trade-veto')
  const rookieDraftStatus = args.rookieDraft ? backendScenarioStatus('rookie-draft') : pickChainStatus
  const browserRookieDraftStatus = browserScenarioStatus('rookie-draft')

  const weeklyLoopStatus = allEnabledEvidencePass([
    ...BROWSER_SCENARIOS.filter(({ weekly }) => weekly).map((scenario) => ({
      enabled: Boolean(args[scenario.flag]),
      status: browserScenarioStatus(scenario.id),
    })),
    { enabled: args.waiverProcessing, status: waiverProcessingStatus },
    { enabled: args.tradeVeto, status: tradeVetoStatus },
    { enabled: args.scoring, status: scoringStatus },
  ])
    ? 'PASS'
    : BROWSER_SCENARIOS.some((scenario) => scenario.weekly && args[scenario.flag]) ||
      args.waiverProcessing || args.tradeVeto || args.scoring
      ? 'PARTIAL'
      : 'PENDING'

  const playoffRowStatus = args.playoffs && args.browserPlayoff
    ? allEnabledEvidencePass([
      { enabled: args.playoffs, status: playoffsStatus },
      { enabled: args.browserPlayoff, status: browserPlayoffStatus },
    ]) ? 'PASS' : hasEnabledEvidencePass(args.playoffs, playoffsStatus) || hasEnabledEvidencePass(args.browserPlayoff, browserPlayoffStatus) ? 'PARTIAL' : 'PENDING'
    : args.browserPlayoff ? browserPlayoffStatus : playoffsStatus

  const rookieDraftRowStatus = args.rookieDraft && args.browserRookieDraft && args.pickChain
    ? allEnabledEvidencePass([
      { enabled: args.rookieDraft, status: rookieDraftStatus },
      { enabled: args.browserRookieDraft, status: browserRookieDraftStatus },
      { enabled: args.pickChain, status: pickChainStatus },
    ]) ? 'PASS' : 'PARTIAL'
    : args.browserRookieDraft ? browserRookieDraftStatus : rookieDraftStatus

  const auctionEvidence = args.auction && args.browserGameplay
    ? 'Auction modes verify the real browser draft-room bid path plus server-side atomic bid validation for <=current, >budget, self-overbid, and valid bid paths.'
    : args.browserGameplay ? 'Browser gameplay mode creates an isolated two-user league, opens the real auction draft room as the bidder, clicks the visible Bid button, and verifies nomination/bid rows changed.' : args.auction ? 'Auction mode creates a disposable auction nomination and verifies the atomic bid RPC rejects <=current, >budget, and self-overbid paths before accepting valid bids.' : 'Enable E2E_ENABLE_BROWSER_GAMEPLAY=1 for browser auction gameplay or E2E_ENABLE_AUCTION=1 for server-side bid validation.'

  const enabledWeeklyEvidence = BROWSER_SCENARIOS
    .filter((scenario) => scenario.weekly && args[scenario.flag])
    .map((scenario) => scenario.evidence)
  const weeklyLoopEvidence = [
    ...enabledWeeklyEvidence,
    ...(args.waiverProcessing ? ['Processes priority, drop, failed-roster, and daily waiver paths.'] : []),
    ...(args.tradeVeto ? ['Verifies member and commissioner trade-veto thresholds.'] : []),
    ...(args.scoring ? ['Finalizes starter-only weekly scoring and standings.'] : []),
  ].join(' ')

  const playoffEvidence = args.browserPlayoff && args.playoffs
    ? 'Playoff modes seed a disposable 10-team season, verify top-six backend bracket generation, block premature advancement, finalize rounds, crown a champion, and verify the real Expo bracket modal champion banner.'
    : args.browserPlayoff ? 'Browser playoff mode creates a disposable 10-team league, generates the real top-six bracket, verifies advance blocking, finalizes playoff rounds, crowns a champion, then opens the real bracket modal and checks the champion banner.' : args.playoffs ? 'Playoff mode seeds a disposable 10-team regular season and calls the real authenticated /playoffs/generate route, then checks for a top-6 bracket.' : 'Enable E2E_ENABLE_BROWSER_PLAYOFF=1 for browser champion coverage or E2E_ENABLE_PLAYOFFS=1 for backend bracket-generation coverage.'

  const rookieDraftEvidence = args.browserRookieDraft && args.rookieDraft && args.pickChain
    ? 'Rookie-draft modes verify inverse-standings snake order, exact pick-asset linkage, lowest-draft-number auto-pick, already-rostered rejection, real browser 30s timer auto-pick, roster insert, and long-horizon traded-pick materialization.'
    : args.browserRookieDraft ? 'Browser rookie-draft mode creates an isolated offseason league, opens the real rookie draft room as the first pick owner, lets the 30s timer expire, and verifies the browser-triggered auto-pick, roster insert, and linked pick asset usage.' : args.rookieDraft ? 'Rookie-draft mode starts a disposable offseason draft through the real backend route, verifies inverse-standings snake order, auto-pick lowest nba_draft_number, exact pick asset usage, roster insert, and already-rostered rejection.' : args.pickChain ? 'Pick-chain mode verifies multi-hop future-pick ownership every season and materializes the traded pick in the target rookie draft year.' : 'Enable E2E_ENABLE_BROWSER_ROOKIE_DRAFT=1 for browser timer auto-pick coverage, E2E_ENABLE_ROOKIE_DRAFT=1 for backend rookie-draft auto-pick/order coverage, or E2E_ENABLE_PICK_CHAIN=1 for long-horizon traded-pick materialization.'

  const coverage = [
    {
      id: 'documentation.audit', requiredForRelease: false,
      requirement: 'Phase A audit report',
      status: auditExists ? 'PASS' : 'PENDING',
      evidence: auditExists ? 'tests/audit-report.md exists.' : 'tests/audit-report.md missing.',
    },
    {
      id: 'documentation.findings', requiredForRelease: false,
      requirement: 'P0/P1 findings resolved',
      status: 'PARTIAL',
      evidence: 'P0/P1 source fixes are documented; service-role JWT literals were purged from reachable local and remote branch history, Edge Functions prefer Supabase secret keys from the platform-provided SUPABASE_SECRET_KEYS dictionary, and local app/E2E env resolves to modern sb_publishable_/sb_secret_ keys. Hosted Supabase Edge API uses modern secret keys, remote legacy JWTs are disabled, and linked DB migration access is verified.',
    },
    {
      id: 'environment.supabase', requiredForRelease: true,
      requirement: 'Real test Supabase project',
      status: env.supabaseUrl && env.serviceRoleKey ? 'PASS' : 'BLOCKED',
      evidence: env.supabaseUrl && env.serviceRoleKey ? 'Supabase URL/admin credentials loaded from E2E/app env.' : 'Missing Supabase admin credentials.',
    },
    {
      id: 'environment.fake_upstream', requiredForRelease: true,
      requirement: 'Fake NBA CDN/Sleeper upstream',
      status: fakeUpstreamStatus,
      evidence: fakeUpstreamStatus === 'PASS'
        ? `Observed NBA CDN and Sleeper requests at http://127.0.0.1:${args.fakePort}; per-season counts are in fake-upstream.json artifacts.`
        : `No observed NBA CDN/Sleeper traffic at http://127.0.0.1:${args.fakePort}.`,
    },
    {
      id: 'setup.auth', requiredForRelease: true,
      requirement: 'D.SET.1 auth/session/sign-out',
      status: browserAuthStatus,
      evidence: args.browserAuth ? 'Browser auth scenario was enabled for this run.' : 'Enable E2E_ENABLE_BROWSER_AUTH=1 or use prior browser-auth artifact.',
    },
    {
      id: 'setup.league_lifecycle', requiredForRelease: true,
      requirement: 'D.SET.2 league create/join/pick bank',
      status: leagueLifecycleStatus,
      evidence: args.leagueLifecycle && args.browserLeagueLifecycle ? 'League-lifecycle mode verifies the 10-user auth/RPC lifecycle, and browser league lifecycle drives the real Expo create/join forms before verifying invite, members, lineup slots, current season, and five-year pick bank.' : args.browserLeagueLifecycle ? 'Browser league lifecycle drives the real Expo create/join forms before verifying invite, members, lineup slots, current season, and five-year pick bank.' : args.leagueLifecycle ? 'League-lifecycle mode signs in seeded users, calls create_league and join_league_by_invite_code through anon Supabase clients, then verifies invite code, members, lineup slots, current season, and five-year pick bank.' : targetLeagueId ? `Seeded target league ${targetLeagueId}; invite, lineup slots, members, and 5y pick-bank proof lives in tests/e2e-seed-report.md.` : 'No target league configured.',
    },
    {
      id: 'setup.settings', requiredForRelease: true,
      requirement: 'D.SET.3 commissioner settings propagation',
      status: settingsStatus,
      evidence: args.settings ? 'Settings mode creates a disposable setup league, updates league/scoring settings and lineup slots through authenticated commissioner-only RPCs, verifies a manager can read them, and checks manager RPC attempts do not mutate commissioner-only settings.' : 'No commissioner settings propagation scenario implemented; enable E2E_ENABLE_SETTINGS=1.',
    },
    {
      id: 'setup.auction', requiredForRelease: true,
      requirement: 'D.SET.4 initial auction draft',
      status: auctionStatus,
      evidence: auctionEvidence,
    },
    {
      id: 'invariants.boundary', requiredForRelease: true,
      requirement: 'D.0 invariant boundary checks',
      status: invariantStatus,
      evidence: rows.length > 0 ? 'Season rows in tests/e2e-report.md include D.0 boundary checks or failure.' : 'No season rows produced.',
    },
    {
      id: 'season.matchups', requiredForRelease: true,
      requirement: 'D.SEA.1 matchup generation idempotency',
      status: matchupStatus,
      evidence: env.backendTicksEnabled ? 'Edge E2E tick mode can call /e2e/generate-matchups twice and compare counts.' : 'Requires E2E_ENABLE_BACKEND_TICKS=1.',
    },
    {
      id: 'season.weekly_loop', requiredForRelease: true,
      requirement: 'D.SEA.2 weekly lineup/scoring/waiver/trade loop',
      status: weeklyLoopStatus,
      evidence: weeklyLoopEvidence,
    },
    {
      id: 'season.injury_filter', requiredForRelease: true,
      requirement: 'D.SEA.2 injury status filtering',
      status: injuryFilterStatus,
      evidence: args.injuryFilter ? 'Injury-filter mode mutates the fake Sleeper upstream, runs the real backend /e2e/sync-players path, and verifies junk injury_status values such as Scrambled are filtered while valid statuses persist.' : 'Enable E2E_ENABLE_INJURY_FILTER=1 to inject fake Sleeper injuries and verify Scrambled is filtered.',
    },
    {
      id: 'season.trade_accept', requiredForRelease: true,
      requirement: 'D.SEA.2 multi-asset trade acceptance',
      status: tradeAcceptStatus,
      evidence: args.tradeAccept ? 'Trade-accept mode creates a disposable player+future-pick trade, verifies mismatched auth/member acceptance is rejected, accepts through the real /trades/:tradeId/accept route, checks assets stay put during the veto window, expires the window, runs /e2e/process-trades, and checks players, picks, trade status, and transaction rows.' : 'Enable E2E_ENABLE_TRADE_ACCEPT=1 to exercise authenticated multi-asset trade acceptance.',
    },
    {
      id: 'season.trade_multi_team', requiredForRelease: true,
      requirement: 'D.SEA.2 multi-team trade browser flow',
      status: browserTradeMultiTeamStatus,
      evidence: args.browserTradeMultiTeam ? 'Multi-team mode verifies proposal, edit, and counter flows through the real responsive browser UI and persisted routed assets.' : 'Enable E2E_ENABLE_BROWSER_TRADE_MULTI_TEAM=1.',
    },
    {
      id: 'season.tiebreakers', requiredForRelease: true,
      requirement: 'D.SEA.3 standings tiebreakers',
      status: tiebreakerStatus,
      evidence: args.tiebreakers ? 'Tiebreaker mode seeds a disposable four-way tie and calls the real authenticated /playoffs/generate route to verify max-points/points-against/deterministic tiebreaker handling.' : 'No forced four-way tie scenario implemented; enable E2E_ENABLE_TIEBREAKERS=1 for standings tiebreaker coverage.',
    },
    {
      id: 'season.playoffs', requiredForRelease: true,
      requirement: 'D.SEA.4 playoffs/champion',
      status: playoffRowStatus,
      evidence: playoffEvidence,
    },
    {
      id: 'season.rookie_draft', requiredForRelease: true,
      requirement: 'D.SEA.5 rookie draft/traded picks',
      status: rookieDraftRowStatus,
      evidence: rookieDraftEvidence,
    },
    {
      id: 'season.reset', requiredForRelease: true,
      requirement: 'D.SEA.6 season reset',
      status: resetStatus,
      evidence: args.seasonReset ? 'Season-reset mode creates a disposable league, calls the real /e2e/advance-season endpoint, and verifies current-season flip, roster carryover, waiver reseed, prior-season queryability, and rolling five-year pick horizon.' : env.backendTicksEnabled ? 'Edge E2E tick mode calls /e2e/advance-season and re-checks invariants.' : 'Requires E2E_ENABLE_BACKEND_TICKS=1 or E2E_ENABLE_SEASON_RESET=1.',
    },
    {
      id: 'season.snapshots', requiredForRelease: true,
      requirement: 'D.SEA.7 snapshots/no shrink',
      status: snapshotStatus,
      evidence: 'Snapshot summaries are written under tests/snapshots/season-<N>/summary.json.',
    },
    {
      id: 'cross.push', requiredForRelease: true,
      requirement: 'D.X.1 push notifications',
      status: pushStatus,
      evidence: args.push && args.draftPush ? 'Push mode verifies trade and waiver notifications through the fake Expo upstream; draft-push mode verifies rookie auto-pick notifications through the same fake Expo intercept.' : args.push ? 'Push mode verifies trade and waiver notifications through the fake Expo upstream; enable E2E_ENABLE_DRAFT_PUSH=1 for draft notifications.' : args.draftPush ? 'Draft-push mode runs a disposable rookie auto-pick and asserts the fake Expo upstream captured a draft notification; enable E2E_ENABLE_PUSH=1 for trade and waiver notifications.' : 'Enable E2E_ENABLE_PUSH=1 and E2E_ENABLE_DRAFT_PUSH=1 to cover trade, waiver, and draft push notifications.',
    },
    {
      id: 'cross.realtime', requiredForRelease: true,
      requirement: 'D.X.2 realtime bid/score events',
      status: realtimeStatus,
      evidence: args.realtime ? 'Realtime mode opens multiple Supabase Realtime clients and asserts both matchup score updates and auction bid nomination updates reach every client within 2s.' : 'Enable E2E_ENABLE_REALTIME=1.',
    },
    {
      id: 'cross.cors', requiredForRelease: true,
      requirement: 'D.X.3 CORS regression',
      status: corsStatus,
      evidence: env.backendTicksEnabled ? 'Edge E2E tick mode runs OPTIONS preflight before the season loop.' : 'Requires Edge E2E tick mode.',
    },
    {
      id: 'cross.performance', requiredForRelease: true,
      requirement: 'D.X.4 perf smoke under draft/live scoring load',
      status: browserPerfStatus,
      evidence: args.browserPerf ? 'Browser perf mode opens the real draft room and home scoreboard while applying continuous auction bids and matchup updates, then asserts responsiveness, screenshots, console output, and browser errors.' : 'Enable E2E_ENABLE_BROWSER_PERF=1 to run the continuous-bid/live-scoring browser perf smoke.',
    },
    {
      id: 'cross.ui_sweep', requiredForRelease: true,
      requirement: 'D.X.5 UI sweep',
      status: browserStatus,
      evidence: args.browserFullSweep ? 'Browser full sweep visits auth, tabs, modals, player, auction-draft, and rookie-draft routes, with screenshots and console/error artifacts.' : browserStatus === 'PARTIAL' ? 'Browser smoke/auth covers auth and tab routes; enable E2E_BROWSER_FULL_SWEEP=1 for modal/player/draft route sweep.' : 'Enable browser smoke/auth; full app route sweep pending.',
    },
    {
      id: 'long.pick_chain', requiredForRelease: true,
      requirement: 'D.LONG.1/D.LONG.2 long-horizon pick trades',
      status: pickChainStatus,
      evidence: args.pickChain ? 'Pick-chain mode creates a three-hop future-pick trade, verifies owner persistence every season, and checks the target rookie-draft slot belongs to the final owner when the pick year arrives.' : 'Enable E2E_ENABLE_PICK_CHAIN=1 to exercise multi-hop pick ownership and rookie-draft materialization.',
    },
    {
      id: 'long.history', requiredForRelease: true,
      requirement: 'D.LONG.3/D.LONG.4 standings/champion history',
      status: historyStatus,
      evidence: args.history ? 'History mode seeds deterministic completed-season standings/champion fixtures and verifies them after season resets.' : 'Enable E2E_ENABLE_HISTORY=1 with Edge E2E tick mode.',
    },
    {
      id: 'long.migration', requiredForRelease: true,
      requirement: 'D.LONG.5 mid-life migration',
      status: midlifeMigrationStatus,
      evidence: args.midlifeMigration ? 'Mid-life migration mode compares the database migration ledger before and after `supabase db push`, requires the expected strictly advancing version, and records tests/artifacts/season-<N>/midlife-migration.json.' : 'Enable E2E_ENABLE_MIDLIFE_MIGRATION=1 with a base-revision database and E2E_MIDLIFE_EXPECTED_VERSION.',
    },
    {
      id: 'long.runtime', requiredForRelease: true,
      requirement: 'D.LONG.6 runtime drift',
      status: runtimeStatus,
      evidence: 'Runtime metrics live in tests/artifacts/perf-metrics.json.',
    },
    {
      id: 'long.memory', requiredForRelease: true,
      requirement: 'D.LONG.7 Node harness memory drift',
      status: memoryStatus,
      evidence: 'Harness memory metrics live in tests/artifacts/perf-metrics.json and 10+ season runs fail if RSS or heap exceeds the configured drift limit.',
    },
    {
      id: 'long.twenty_seasons', requiredForRelease: true,
      requirement: '10 seasons and continue past 10 / 20 clean',
      status: status === 'PASS' && seasons >= 20 ? 'PASS' : status === 'FAIL' ? 'FAIL' : seasons >= 20 ? 'PARTIAL' : 'PENDING',
      evidence: `Current run status is ${status} for target ${seasons} season(s); PARTIAL means enabled season rows passed but full gameplay coverage is still pending.`,
    },
  ]
  const productionStatus = productionCoverageStatus(coverage)
  coverage.push({
    id: 'release.production', requiredForRelease: false,
    requirement: 'Production-ready exit criteria',
    status: productionStatus,
    evidence: productionStatus === 'PASS'
      ? 'Every required release row has passing structural evidence.'
      : 'Production exit requires every operational coverage row to report PASS in release-gate mode.',
  })

  const lines = [
    '# E2E Coverage Checklist',
    '',
    `- Run status: ${status}`,
    `- Started: ${startedAt}`,
    `- Finished: ${finishedAt}`,
    `- Target seasons: ${seasons}`,
    '',
    '## Prompt-To-Artifact Matrix',
    '',
    '| Requirement | Status | Evidence |',
    '| --- | --- | --- |',
    ...coverage.map((row) => `| ${row.requirement} | ${row.status} | ${row.evidence.replaceAll('\n', '<br>')} |`),
    '',
    '## Run Notes',
    '',
    ...notes.map((note) => `- ${note}`),
  ]
  await writeFile(COVERAGE_PATH, `${lines.join('\n')}\n`)
  return { status: productionStatus, coverage }
}

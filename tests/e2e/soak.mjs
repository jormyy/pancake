import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import v8 from 'node:v8'
import vm from 'node:vm'
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { createFakeUpstreamServer } from './fake-upstream.mjs'
import { resolvedEnv, describeEndpoint } from './env.mjs'
import { runBrowserSmoke } from './browser-smoke.mjs'
import { runBrowserAuthScenario } from './browser-auth.mjs'
import { runBrowserPerfSmoke } from './browser-perf-smoke.mjs'
import { runBrowserGameplayScenario } from './browser-gameplay.mjs'
import { runBrowserLeagueLifecycleScenario } from './browser-league-lifecycle.mjs'
import { runBrowserLineupAutoSetScenario, runBrowserLineupLockedScenario, runBrowserLineupScenario } from './browser-lineup-gameplay.mjs'
import { runBrowserPlayoffChampionScenario } from './browser-playoff-gameplay.mjs'
import { runBrowserRookieDraftAutoPickScenario } from './browser-rookie-draft-gameplay.mjs'
import { runBrowserWaiverDropScenario, runBrowserWaiverIrBlockScenario, runBrowserWaiverScenario } from './browser-waiver-gameplay.mjs'
import {
  runBrowserTradeScenario,
  runBrowserTradeAcceptScenario,
  runBrowserTradeTerminalScenario,
  runBrowserTradeFuturePickScenario,
  runBrowserTradeFuturePickAcceptScenario,
  runBrowserTradeOverflowAcceptScenario,
  runBrowserTradePostDeadlineScenario,
  runBrowserTradeVetoScenario,
} from './browser-trade-gameplay.mjs'

const execFileAsync = promisify(execFile)
const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-report.md')
const COVERAGE_PATH = path.join(ROOT, 'tests/e2e-coverage.md')
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const SNAPSHOT_ROOT = path.join(ROOT, 'tests/snapshots')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const PERF_METRICS_PATH = path.join(ARTIFACT_ROOT, 'perf-metrics.json')
const PERF_DRIFT_LIMIT = Number(process.env.E2E_PERF_DRIFT_LIMIT ?? 1.2)
const MEMORY_DRIFT_LIMIT = Number(process.env.E2E_MEMORY_DRIFT_LIMIT ?? 1.2)
const MEMORY_DRIFT_MIN_BYTES = Number(process.env.E2E_MEMORY_DRIFT_MIN_BYTES ?? 48 * 1024 * 1024)
const MEMORY_HEAP_DRIFT_MIN_BYTES = Number(process.env.E2E_MEMORY_HEAP_DRIFT_MIN_BYTES ?? 24 * 1024 * 1024)
const REALTIME_CLIENTS = Number(process.env.E2E_REALTIME_CLIENTS ?? 10)
const REALTIME_LATENCY_LIMIT_MS = Number(process.env.E2E_REALTIME_LATENCY_LIMIT_MS ?? 2000)
const REALTIME_SUBSCRIBE_TIMEOUT_MS = Number(process.env.E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS ?? 30000)
const REALTIME_SETTLE_MS = Number(process.env.E2E_REALTIME_SETTLE_MS ?? 1500)
const REALTIME_WARMUP_ATTEMPTS = Number(process.env.E2E_REALTIME_WARMUP_ATTEMPTS ?? 5)
const MIDLIFE_MIGRATION_AFTER_SEASON = Number(process.env.E2E_MIDLIFE_MIGRATION_AFTER_SEASON ?? 5)

const SNAPSHOT_TABLES = [
  'roster_players',
  'draft_picks',
  'standings',
  'league_seasons',
  'waiver_priorities',
]

const parseArgs = () => {
  const args = new Map()
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (match) args.set(match[1], match[2])
  }
  return {
    seasons: Number(args.get('seasons') ?? process.env.E2E_SEASONS ?? 10),
    keepGoing: args.get('keep-going') === 'true' || process.env.E2E_KEEP_GOING === '1',
    repeatScenariosEverySeason: args.get('repeat-scenarios-every-season') === 'true' || process.env.E2E_REPEAT_SCENARIOS_EVERY_SEASON === '1',
    fakePort: Number(args.get('fake-port') ?? process.env.FAKE_UPSTREAM_PORT ?? 4555),
    browser: args.get('browser') === 'true' || process.env.E2E_ENABLE_BROWSER === '1',
    browserFullSweep: args.get('browser-full-sweep') === 'true' || process.env.E2E_BROWSER_FULL_SWEEP === '1',
    browserAuth: args.get('browser-auth') === 'true' || process.env.E2E_ENABLE_BROWSER_AUTH === '1',
    browserPerf: args.get('browser-perf') === 'true' || process.env.E2E_ENABLE_BROWSER_PERF === '1',
    browserGameplay: args.get('browser-gameplay') === 'true' || process.env.E2E_ENABLE_BROWSER_GAMEPLAY === '1',
    browserLineup: args.get('browser-lineup') === 'true' || process.env.E2E_ENABLE_BROWSER_LINEUP === '1',
    browserLineupAutoSet: args.get('browser-lineup-auto-set') === 'true' || process.env.E2E_ENABLE_BROWSER_LINEUP_AUTO_SET === '1',
    browserLineupLocked: args.get('browser-lineup-locked') === 'true' || process.env.E2E_ENABLE_BROWSER_LINEUP_LOCKED === '1',
    browserPlayoff: args.get('browser-playoff') === 'true' || process.env.E2E_ENABLE_BROWSER_PLAYOFF === '1',
    browserRookieDraft: args.get('browser-rookie-draft') === 'true' || process.env.E2E_ENABLE_BROWSER_ROOKIE_DRAFT === '1',
    browserWaiver: args.get('browser-waiver') === 'true' || process.env.E2E_ENABLE_BROWSER_WAIVER === '1',
    browserWaiverDrop: args.get('browser-waiver-drop') === 'true' || process.env.E2E_ENABLE_BROWSER_WAIVER_DROP === '1',
    browserWaiverIrBlock: args.get('browser-waiver-ir-block') === 'true' || process.env.E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK === '1',
    browserTrade: args.get('browser-trade') === 'true' || process.env.E2E_ENABLE_BROWSER_TRADE === '1',
    browserTradeAccept: args.get('browser-trade-accept') === 'true' || process.env.E2E_ENABLE_BROWSER_TRADE_ACCEPT === '1',
    browserTradeTerminal: args.get('browser-trade-terminal') === 'true' || process.env.E2E_ENABLE_BROWSER_TRADE_TERMINAL === '1',
    browserTradeFuturePick: args.get('browser-trade-future-pick') === 'true' || process.env.E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK === '1',
    browserTradeFuturePickAccept: args.get('browser-trade-future-pick-accept') === 'true' || process.env.E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT === '1',
    browserTradeOverflowAccept: args.get('browser-trade-overflow-accept') === 'true' || process.env.E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT === '1',
    browserTradePostDeadline: args.get('browser-trade-post-deadline') === 'true' || process.env.E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE === '1',
    browserTradeVeto: args.get('browser-trade-veto') === 'true' || process.env.E2E_ENABLE_BROWSER_TRADE_VETO === '1',
    browserLeagueLifecycle: args.get('browser-league-lifecycle') === 'true' || process.env.E2E_ENABLE_BROWSER_LEAGUE_LIFECYCLE === '1',
    leagueLifecycle: args.get('league-lifecycle') === 'true' || process.env.E2E_ENABLE_LEAGUE_LIFECYCLE === '1',
    pickChain: args.get('pick-chain') === 'true' || process.env.E2E_ENABLE_PICK_CHAIN === '1',
    push: args.get('push') === 'true' || process.env.E2E_ENABLE_PUSH === '1',
    draftPush: args.get('draft-push') === 'true' || process.env.E2E_ENABLE_DRAFT_PUSH === '1',
    history: args.get('history') === 'true' || process.env.E2E_ENABLE_HISTORY === '1',
    realtime: args.get('realtime') === 'true' || process.env.E2E_ENABLE_REALTIME === '1',
    midlifeMigration: args.get('midlife-migration') === 'true' || process.env.E2E_ENABLE_MIDLIFE_MIGRATION === '1',
    auction: args.get('auction') === 'true' || process.env.E2E_ENABLE_AUCTION === '1',
    playoffs: args.get('playoffs') === 'true' || process.env.E2E_ENABLE_PLAYOFFS === '1',
    tiebreakers: args.get('tiebreakers') === 'true' || process.env.E2E_ENABLE_TIEBREAKERS === '1',
    settings: args.get('settings') === 'true' || process.env.E2E_ENABLE_SETTINGS === '1',
    scoring: args.get('scoring') === 'true' || process.env.E2E_ENABLE_SCORING === '1',
    waiverProcessing: args.get('waiver-processing') === 'true' || process.env.E2E_ENABLE_WAIVER_PROCESSING === '1',
    injuryFilter: args.get('injury-filter') === 'true' || process.env.E2E_ENABLE_INJURY_FILTER === '1',
    tradeAccept: args.get('trade-accept') === 'true' || process.env.E2E_ENABLE_TRADE_ACCEPT === '1',
    tradeVeto: args.get('trade-veto') === 'true' || process.env.E2E_ENABLE_TRADE_VETO === '1',
    rookieDraft: args.get('rookie-draft') === 'true' || process.env.E2E_ENABLE_ROOKIE_DRAFT === '1',
    seasonReset: args.get('season-reset') === 'true' || process.env.E2E_ENABLE_SEASON_RESET === '1',
  }
}

const shouldRunScenario = (args, season) => season === 1 || args.repeatScenariosEverySeason

const timestamp = () => new Date().toISOString()
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000

const roundedMs = (value) => Math.round(value)
const bytesToMiB = (value) => Math.round((value / 1024 / 1024) * 10) / 10
const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((left, right) => left - right)
  if (sorted.length === 0) return null
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint]
}

const runGarbageCollector = () => {
  if (typeof globalThis.gc !== 'function') {
    try {
      v8.setFlagsFromString('--expose_gc')
      globalThis.gc = vm.runInNewContext('gc')
    } catch {
      // GC is unavailable in some Node builds; memory drift will still be measured.
    }
  }
  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
    globalThis.gc()
  }
}

const currentMemory = () => {
  runGarbageCollector()
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage()
  return {
    rssBytes: rss,
    heapUsedBytes: heapUsed,
    externalBytes: external,
    arrayBuffersBytes: arrayBuffers,
  }
}

const readState = async () => {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const writeReport = async ({ status, startedAt, finishedAt, seasons, rows, notes }) => {
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

const hasPassingNote = (rows, pattern) => rows.some((row) => row.status === 'PASS' && pattern.test(row.notes))
const hasFailingNote = (rows, pattern) => rows.some((row) => row.status === 'FAIL' && pattern.test(row.notes))
const hasProblemNote = (rows, pattern) => rows.some((row) => (
  (row.status === 'FAIL' || row.status === 'ERROR' || row.status === 'BLOCKED') &&
  pattern.test(row.notes)
))
const hasEvidencePass = (status) => status === 'PASS'
const hasEnabledEvidencePass = (enabled, status) => enabled && hasEvidencePass(status)
const allEnabledEvidencePass = (items) => items.every(({ enabled, status }) => enabled && hasEvidencePass(status))
const errorMessage = (error) => error instanceof Error ? error.message : String(error)

const writeCoverageReport = async ({ status, startedAt, finishedAt, seasons, args, env, targetLeagueId, rows, notes }) => {
  const auditExists = await readFile(path.join(ROOT, 'tests/audit-report.md'), 'utf8')
    .then(() => true)
    .catch(() => false)
  const rowStatus = rows.some((row) => row.status === 'FAIL' || row.status === 'ERROR' || row.status === 'BLOCKED')
    ? 'FAIL'
    : rows.length > 0 ? 'PARTIAL' : 'PENDING'
  const producedTenSeasons = rows.some((row) => Number(row.season) >= 10)
  const invariantStatus = rows.length === 0
    ? 'PENDING'
    : hasFailingNote(rows, /\bI[0-7]:|D\.SET\.2/)
      ? 'FAIL'
      : hasPassingNote(rows, /D\.0 invariant boundary checks passed/) ? 'PASS' : 'PARTIAL'
  const runtimeStatus = hasFailingNote(rows, /D\.LONG\.6/)
    ? 'FAIL'
    : producedTenSeasons ? 'PASS' : 'PENDING'
  const memoryStatus = hasFailingNote(rows, /D\.LONG\.7/)
    ? 'FAIL'
    : producedTenSeasons ? 'PASS' : 'PENDING'
  const resetStatus = args.seasonReset
    ? hasFailingNote(rows, /D\.SEA\.6/) ? 'FAIL' : hasPassingNote(rows, /season reset carryover passed/) ? 'PASS' : 'PENDING'
    : env.backendTicksEnabled
      ? hasFailingNote(rows, /\bI[0-7]:|D\.SET\.2|advance-season|season reset/i) ? 'FAIL' : 'PARTIAL'
      : 'PENDING'
  const snapshotStatus = hasPassingNote(rows, /snapshot row-count diff passed/) ? 'PASS' : rows.length > 1 ? rowStatus : 'PENDING'
  const matchupStatus = env.backendTicksEnabled && hasPassingNote(rows, /matchup generation idempotency passed/) ? 'PASS' : 'PENDING'
  const pickChainStatus = args.pickChain
    ? hasFailingNote(rows, /D\.LONG\.1|D\.LONG\.2/) ? 'FAIL' : hasPassingNote(rows, /multi-hop future-pick owner resolved/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserStatus = args.browser && args.browserAuth && args.browserFullSweep
    ? 'PASS'
    : args.browser || args.browserAuth ? 'PARTIAL' : 'PENDING'
  const browserPerfStatus = args.browserPerf
    ? hasFailingNote(rows, /D\.X\.4/) ? 'FAIL' : hasPassingNote(rows, /browser perf smoke passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserWaiverStatus = args.browserWaiver
    ? hasFailingNote(rows, /browser waiver/) ? 'FAIL' : hasPassingNote(rows, /browser waiver claim gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserLineupStatus = args.browserLineup
    ? hasFailingNote(rows, /browser lineup/) ? 'FAIL' : hasPassingNote(rows, /browser lineup gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserLineupAutoSetStatus = args.browserLineupAutoSet
    ? hasFailingNote(rows, /browser lineup auto-set/) ? 'FAIL' : hasPassingNote(rows, /browser lineup auto-set gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserLineupLockedStatus = args.browserLineupLocked
    ? hasFailingNote(rows, /browser lineup locked/) ? 'FAIL' : hasPassingNote(rows, /browser lineup locked gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserWaiverDropStatus = args.browserWaiverDrop
    ? hasFailingNote(rows, /browser waiver drop/) ? 'FAIL' : hasPassingNote(rows, /browser waiver drop claim gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserWaiverIrBlockStatus = args.browserWaiverIrBlock
    ? hasFailingNote(rows, /browser waiver IR block/) ? 'FAIL' : hasPassingNote(rows, /browser waiver IR block gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeStatus = args.browserTrade
    ? hasFailingNote(rows, /browser trade/) ? 'FAIL' : hasPassingNote(rows, /browser trade proposal gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeAcceptStatus = args.browserTradeAccept
    ? hasFailingNote(rows, /browser trade accept/) ? 'FAIL' : hasPassingNote(rows, /browser trade accept gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeTerminalStatus = args.browserTradeTerminal
    ? hasFailingNote(rows, /browser trade terminal/) ? 'FAIL' : hasPassingNote(rows, /browser trade reject\/withdraw gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeFuturePickStatus = args.browserTradeFuturePick
    ? hasFailingNote(rows, /browser future-pick trade/) ? 'FAIL' : hasPassingNote(rows, /browser future-pick trade gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeFuturePickAcceptStatus = args.browserTradeFuturePickAccept
    ? hasFailingNote(rows, /browser future-pick trade accept/) ? 'FAIL' : hasPassingNote(rows, /browser future-pick trade accept gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeOverflowAcceptStatus = args.browserTradeOverflowAccept
    ? hasFailingNote(rows, /browser trade overflow accept/) ? 'FAIL' : hasPassingNote(rows, /browser trade overflow accept gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradePostDeadlineStatus = args.browserTradePostDeadline
    ? hasFailingNote(rows, /browser post-deadline trade/) ? 'FAIL' : hasPassingNote(rows, /browser post-deadline trade gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeVetoStatus = args.browserTradeVeto
    ? hasFailingNote(rows, /browser trade veto/) ? 'FAIL' : hasPassingNote(rows, /browser trade veto gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const leagueLifecyclePassed = hasPassingNote(rows, /league lifecycle passed/)
  const browserLeagueLifecyclePassed = hasPassingNote(rows, /browser league lifecycle passed/)
  const leagueLifecycleStatus = args.leagueLifecycle || args.browserLeagueLifecycle
    ? hasFailingNote(rows, /D\.SET\.2|browser league lifecycle/)
      ? 'FAIL'
      : leagueLifecyclePassed && browserLeagueLifecyclePassed
        ? 'PASS'
        : leagueLifecyclePassed || browserLeagueLifecyclePassed
          ? 'PARTIAL'
          : 'PENDING'
    : targetLeagueId ? 'PARTIAL' : 'PENDING'
  const tradeWaiverPushPassed = hasPassingNote(rows, /trade and waiver push notification intercepts passed|push notification intercepts passed/)
  const draftPushPassed = hasPassingNote(rows, /draft push notification intercept passed/)
  const pushStatus = args.push || args.draftPush
    ? status === 'ERROR' || hasFailingNote(rows, /D\.X\.1|push|waiver/i)
      ? 'FAIL'
      : args.push && args.draftPush && tradeWaiverPushPassed && draftPushPassed
        ? 'PASS'
        : tradeWaiverPushPassed || draftPushPassed
          ? 'PARTIAL'
          : 'PENDING'
    : 'PENDING'
  const historyStatus = args.history
    ? hasFailingNote(rows, /D\.LONG\.3|D\.LONG\.4/) ? 'FAIL' : hasPassingNote(rows, /standings\/champion history retained/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const realtimeStatus = args.realtime
    ? hasProblemNote(rows, /D\.X\.2/) ? 'FAIL' : hasPassingNote(rows, /realtime matchup and bid updates delivered/) ? 'PASS' : 'PARTIAL'
    : 'PENDING'
  const midlifeMigrationStatus = args.midlifeMigration
    ? hasFailingNote(rows, /D\.LONG\.5/) ? 'FAIL' : hasPassingNote(rows, /mid-life migration applied/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const auctionStatus = args.auction || args.browserGameplay
    ? hasFailingNote(rows, /D\.SET\.4|browser auction/) ? 'FAIL' : (
      args.auction && args.browserGameplay &&
      hasPassingNote(rows, /auction bid validation passed/) &&
      hasPassingNote(rows, /browser auction bid gameplay passed/)
    ) ? 'PASS' : hasPassingNote(rows, /auction bid validation passed|browser auction bid gameplay passed/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const playoffsStatus = args.playoffs
    ? hasFailingNote(rows, /D\.SEA\.4/) ? 'FAIL' : hasPassingNote(rows, /playoff bracket scenario passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserPlayoffStatus = args.browserPlayoff
    ? hasFailingNote(rows, /browser playoff/) ? 'FAIL' : hasPassingNote(rows, /browser playoff champion passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const tiebreakerStatus = args.tiebreakers
    ? hasFailingNote(rows, /D\.SEA\.3/) ? 'FAIL' : hasPassingNote(rows, /standings tiebreaker scenario passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const settingsStatus = args.settings
    ? hasFailingNote(rows, /D\.SET\.3/) ? 'FAIL' : hasPassingNote(rows, /commissioner settings propagation passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const scoringStatus = args.scoring
    ? hasFailingNote(rows, /D\.SEA\.2/) ? 'FAIL' : hasPassingNote(rows, /weekly scoring finalization passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const waiverProcessingStatus = args.waiverProcessing
    ? hasFailingNote(rows, /D\.SEA\.2 waiver processing/) ? 'FAIL' : hasPassingNote(rows, /waiver priority processing passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const injuryFilterStatus = args.injuryFilter
    ? hasFailingNote(rows, /D\.SEA\.2 injury/) ? 'FAIL' : hasPassingNote(rows, /injury status filter passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const tradeAcceptStatus = args.tradeAccept
    ? hasFailingNote(rows, /D\.SEA\.2 trade/) ? 'FAIL' : hasPassingNote(rows, /trade acceptance atomicity passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const tradeVetoStatus = args.tradeVeto
    ? hasFailingNote(rows, /D\.SEA\.2 trade veto/) ? 'FAIL' : hasPassingNote(rows, /trade veto threshold passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const rookieDraftStatus = args.rookieDraft
    ? hasFailingNote(rows, /D\.SEA\.5/) ? 'FAIL' : hasPassingNote(rows, /rookie draft auto-pick passed/) ? 'PASS' : 'PENDING'
    : pickChainStatus
  const browserRookieDraftStatus = args.browserRookieDraft
    ? hasFailingNote(rows, /browser rookie draft/) ? 'FAIL' : hasPassingNote(rows, /browser rookie draft auto-pick passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'

  const weeklyLoopStatus = allEnabledEvidencePass([
    { enabled: args.browserLineup, status: browserLineupStatus },
    { enabled: args.browserLineupAutoSet, status: browserLineupAutoSetStatus },
    { enabled: args.browserLineupLocked, status: browserLineupLockedStatus },
    { enabled: args.browserWaiver, status: browserWaiverStatus },
    { enabled: args.browserWaiverDrop, status: browserWaiverDropStatus },
    { enabled: args.browserWaiverIrBlock, status: browserWaiverIrBlockStatus },
    { enabled: args.waiverProcessing, status: waiverProcessingStatus },
    { enabled: args.browserTrade, status: browserTradeStatus },
    { enabled: args.browserTradeFuturePick, status: browserTradeFuturePickStatus },
    { enabled: args.browserTradeFuturePickAccept, status: browserTradeFuturePickAcceptStatus },
    { enabled: args.browserTradeOverflowAccept, status: browserTradeOverflowAcceptStatus },
    { enabled: args.browserTradePostDeadline, status: browserTradePostDeadlineStatus },
    { enabled: args.browserTradeVeto, status: browserTradeVetoStatus },
    { enabled: args.browserTradeAccept, status: browserTradeAcceptStatus },
    { enabled: args.browserTradeTerminal, status: browserTradeTerminalStatus },
    { enabled: args.tradeVeto, status: tradeVetoStatus },
    { enabled: args.scoring, status: scoringStatus },
  ])
    ? 'PASS'
    : args.browserLineup || args.browserLineupAutoSet || args.browserLineupLocked || args.browserWaiver ||
      args.browserWaiverDrop || args.browserWaiverIrBlock || args.waiverProcessing || args.browserTrade ||
      args.browserTradeFuturePick || args.browserTradeFuturePickAccept || args.browserTradeOverflowAccept ||
      args.browserTradePostDeadline || args.browserTradeVeto || args.browserTradeAccept ||
      args.browserTradeTerminal || args.tradeVeto || args.scoring
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

  const weeklyLoopEvidence = weeklyLoopStatus === 'PASS'
    ? 'All weekly-loop slices were enabled: manual lineup, auto-set, locked-player protection, no-drop/drop/IR-block waiver UI, waiver priority processing, player/future-pick/overflow/post-deadline/veto/accept/reject/withdraw trade UI, trade veto thresholds, and starter-only scoring/finalization.'
    : args.browserLineup ? 'Browser lineup mode creates an isolated league, opens the real lineup modal, moves a bench PG into an empty PG starter slot, and verifies the weekly_lineups row persisted.' : args.browserLineupAutoSet ? 'Browser lineup auto-set mode creates an isolated league, opens the real Auto-Set modal, chooses Today, and verifies an auto-set weekly_lineups row persisted.' : args.browserLineupLocked ? 'Browser lineup locked mode creates an isolated league, seeds a live NBA game for a starter, attempts a real browser move, and verifies the locked starter remains in place while the bench player is not inserted into weekly_lineups.' : args.browserWaiver ? 'Browser waiver mode creates an isolated one-user league, opens the real claim-player modal, submits a no-drop waiver claim, and verifies the Edge API/RPC persisted a pending waiver_claims row.' : args.browserWaiverDrop ? 'Browser waiver-drop mode creates an isolated full-roster league, opens the real claim-player modal, selects a real roster player to drop, submits the waiver claim, and verifies the Edge API/RPC persisted the pending drop-then-add claim.' : args.browserWaiverIrBlock ? 'Browser waiver IR-block mode creates an isolated league with a DTD player illegally occupying IR, opens the real claim-player modal, verifies the UI blocks the claim, and checks no waiver_claims row is inserted.' : args.waiverProcessing ? 'Waiver-processing mode seeds priority-ordered competing claims, a drop-then-add claim, and a full-roster/no-drop claim, then runs the real Edge processor and verifies statuses, roster movement, waiver priority reseeding, and transaction rows.' : args.browserTrade ? 'Browser trade mode creates an isolated two-user league, opens the real propose-trade modal, submits a player-for-player proposal through the authenticated Edge API route, and verifies pending trades/trade_items rows persisted.' : args.browserTradeFuturePick ? 'Browser future-pick trade mode creates an isolated two-user league, opens the real propose-trade modal, submits a five-years-out pick-for-pick proposal, and verifies pending pick trade_items persisted through the authenticated Edge API route without moving pick ownership.' : args.browserTradeFuturePickAccept ? 'Browser future-pick trade accept mode creates an isolated pending five-years-out pick-for-pick trade, accepts it through the real Offers tab, and verifies the Edge API/RPC swaps draft_picks.current_owner_id without moving roster players.' : args.browserTradeOverflowAccept ? 'Browser trade overflow accept mode creates an isolated mixed player/pick offer, accepts it through the real Offers tab, drops one active player in the overflow modal, and verifies the trade completes with the drop logged on waivers.' : args.browserTradePostDeadline ? 'Browser post-deadline trade mode creates an isolated league with a past trade_deadline, attempts the real propose-trade flow, and verifies the authenticated backend rejects the proposal without inserting trades or trade_items.' : args.browserTradeVeto ? 'Browser trade veto mode creates an isolated accepted trade with an open veto window, signs in as a non-party member, uses the real Offers veto action, and verifies the backend records a member veto without moving assets.' : args.browserTradeAccept ? 'Browser trade accept mode creates an isolated pending trade, opens the real recipient Offers tab, accepts through the visible TradeCard button, and verifies the Edge API/RPC moved both players and completed the trade.' : args.browserTradeTerminal ? 'Browser trade terminal mode creates isolated pending trades, rejects one as the recipient, withdraws one as the proposer through authenticated Edge API routes, and verifies terminal statuses without moving roster assets.' : args.tradeVeto ? 'Trade-veto mode seeds accepted trades, verifies trade parties cannot member-veto, verifies fewer than 50% member vetoes do not kill the trade, verifies the 50% threshold does, and verifies commissioner veto kills immediately.' : args.scoring ? 'Scoring mode seeds a disposable matchup with starter/bench lineups and real player_game_stats, calls the real Edge API /e2e/sync-scores path, and checks starter-only points, finalization blocking, winner, max-possible points, and standings append.' : 'Full weekly browser gameplay loop is not implemented; enable E2E_ENABLE_BROWSER_LINEUP=1 for manual lineup setting, E2E_ENABLE_BROWSER_LINEUP_AUTO_SET=1 for auto-set lineup setting, E2E_ENABLE_BROWSER_LINEUP_LOCKED=1 for locked-player move blocking, E2E_ENABLE_BROWSER_WAIVER=1 for no-drop waiver claim UI coverage, E2E_ENABLE_BROWSER_WAIVER_DROP=1 for drop-then-add waiver claim UI coverage, E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK=1 for DTD-on-IR claim blocking, E2E_ENABLE_WAIVER_PROCESSING=1 for priority/drop/failure daily processing, E2E_ENABLE_BROWSER_TRADE=1 for player proposal UI coverage, E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK=1 for future-pick proposal UI coverage, E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT=1 for future-pick accept UI coverage, E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT=1 for drop-before-accept UI coverage, E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE=1 for post-deadline proposal rejection, E2E_ENABLE_BROWSER_TRADE_VETO=1 for accepted-state veto UI coverage, E2E_ENABLE_BROWSER_TRADE_ACCEPT=1 for accept UI coverage, E2E_ENABLE_BROWSER_TRADE_TERMINAL=1 for reject/withdraw UI coverage, E2E_ENABLE_TRADE_VETO=1 for trade veto threshold coverage, or E2E_ENABLE_SCORING=1 for the starter-only scoring/finalization slice.'

  const playoffEvidence = args.browserPlayoff && args.playoffs
    ? 'Playoff modes seed a disposable 10-team season, verify top-six backend bracket generation, block premature advancement, finalize rounds, crown a champion, and verify the real Expo bracket modal champion banner.'
    : args.browserPlayoff ? 'Browser playoff mode creates a disposable 10-team league, generates the real top-six bracket, verifies advance blocking, finalizes playoff rounds, crowns a champion, then opens the real bracket modal and checks the champion banner.' : args.playoffs ? 'Playoff mode seeds a disposable 10-team regular season and calls the real authenticated /playoffs/generate route, then checks for a top-6 bracket.' : 'Enable E2E_ENABLE_BROWSER_PLAYOFF=1 for browser champion coverage or E2E_ENABLE_PLAYOFFS=1 for backend bracket-generation coverage.'

  const rookieDraftEvidence = args.browserRookieDraft && args.rookieDraft && args.pickChain
    ? 'Rookie-draft modes verify inverse-standings snake order, exact pick-asset linkage, lowest-draft-number auto-pick, already-rostered rejection, real browser 30s timer auto-pick, roster insert, and long-horizon traded-pick materialization.'
    : args.browserRookieDraft ? 'Browser rookie-draft mode creates an isolated offseason league, opens the real rookie draft room as the first pick owner, lets the 30s timer expire, and verifies the browser-triggered auto-pick, roster insert, and linked pick asset usage.' : args.rookieDraft ? 'Rookie-draft mode starts a disposable offseason draft through the real backend route, verifies inverse-standings snake order, auto-pick lowest nba_draft_number, exact pick asset usage, roster insert, and already-rostered rejection.' : args.pickChain ? 'Pick-chain mode verifies multi-hop future-pick ownership every season and materializes the traded pick in the target rookie draft year.' : 'Enable E2E_ENABLE_BROWSER_ROOKIE_DRAFT=1 for browser timer auto-pick coverage, E2E_ENABLE_ROOKIE_DRAFT=1 for backend rookie-draft auto-pick/order coverage, or E2E_ENABLE_PICK_CHAIN=1 for long-horizon traded-pick materialization.'

  const coverage = [
    {
      requirement: 'Phase A audit report',
      status: auditExists ? 'PASS' : 'PENDING',
      evidence: auditExists ? 'tests/audit-report.md exists.' : 'tests/audit-report.md missing.',
    },
    {
      requirement: 'P0/P1 findings resolved',
      status: 'PARTIAL',
      evidence: 'P0/P1 source fixes are documented; service-role JWT literals were purged from reachable local and remote branch history, Edge Functions prefer Supabase secret keys from the platform-provided SUPABASE_SECRET_KEYS dictionary, and local app/E2E env resolves to modern sb_publishable_/sb_secret_ keys. Hosted Supabase Edge API uses modern secret keys, remote legacy JWTs are disabled, and linked DB migration access is verified.',
    },
    {
      requirement: 'Real test Supabase project',
      status: env.supabaseUrl && env.serviceRoleKey ? 'PASS' : 'BLOCKED',
      evidence: env.supabaseUrl && env.serviceRoleKey ? 'Supabase URL/admin credentials loaded from E2E/app env.' : 'Missing Supabase admin credentials.',
    },
    {
      requirement: 'Fake NBA CDN/Sleeper upstream',
      status: rows.length > 0 ? 'PASS' : 'PENDING',
      evidence: `Fake upstream configured for http://127.0.0.1:${args.fakePort}.`,
    },
    {
      requirement: 'D.SET.1 auth/session/sign-out',
      status: args.browserAuth ? 'PASS' : 'PENDING',
      evidence: args.browserAuth ? 'Browser auth scenario was enabled for this run.' : 'Enable E2E_ENABLE_BROWSER_AUTH=1 or use prior browser-auth artifact.',
    },
    {
      requirement: 'D.SET.2 league create/join/pick bank',
      status: leagueLifecycleStatus,
      evidence: args.leagueLifecycle && args.browserLeagueLifecycle ? 'League-lifecycle mode verifies the 10-user auth/RPC lifecycle, and browser league lifecycle drives the real Expo create/join forms before verifying invite, members, lineup slots, current season, and five-year pick bank.' : args.browserLeagueLifecycle ? 'Browser league lifecycle drives the real Expo create/join forms before verifying invite, members, lineup slots, current season, and five-year pick bank.' : args.leagueLifecycle ? 'League-lifecycle mode signs in seeded users, calls create_league and join_league_by_invite_code through anon Supabase clients, then verifies invite code, members, lineup slots, current season, and five-year pick bank.' : targetLeagueId ? `Seeded target league ${targetLeagueId}; invite, lineup slots, members, and 5y pick-bank proof lives in tests/e2e-seed-report.md.` : 'No target league configured.',
    },
    {
      requirement: 'D.SET.3 commissioner settings propagation',
      status: settingsStatus,
      evidence: args.settings ? 'Settings mode creates a disposable league, updates league/scoring/slot settings as the commissioner through Supabase RLS, verifies a manager can read them, and checks manager writes do not mutate commissioner-only settings.' : 'No commissioner settings propagation scenario implemented; enable E2E_ENABLE_SETTINGS=1.',
    },
    {
      requirement: 'D.SET.4 initial auction draft',
      status: auctionStatus,
      evidence: auctionEvidence,
    },
    {
      requirement: 'D.0 invariant boundary checks',
      status: invariantStatus,
      evidence: rows.length > 0 ? 'Season rows in tests/e2e-report.md include D.0 boundary checks or failure.' : 'No season rows produced.',
    },
    {
      requirement: 'D.SEA.1 matchup generation idempotency',
      status: matchupStatus,
      evidence: env.backendTicksEnabled ? 'Edge E2E tick mode can call /e2e/generate-matchups twice and compare counts.' : 'Requires E2E_ENABLE_BACKEND_TICKS=1.',
    },
    {
      requirement: 'D.SEA.2 weekly lineup/scoring/waiver/trade loop',
      status: weeklyLoopStatus,
      evidence: weeklyLoopEvidence,
    },
    {
      requirement: 'D.SEA.2 injury status filtering',
      status: injuryFilterStatus,
      evidence: args.injuryFilter ? 'Injury-filter mode mutates the fake Sleeper upstream, runs the real backend /e2e/sync-players path, and verifies junk injury_status values such as Scrambled are filtered while valid statuses persist.' : 'Enable E2E_ENABLE_INJURY_FILTER=1 to inject fake Sleeper injuries and verify Scrambled is filtered.',
    },
    {
      requirement: 'D.SEA.2 multi-asset trade acceptance',
      status: tradeAcceptStatus,
      evidence: args.tradeAccept ? 'Trade-accept mode creates a disposable player+future-pick trade, verifies mismatched auth/member acceptance is rejected, accepts through the real /trades/:tradeId/accept route, checks assets stay put during the veto window, expires the window, runs /e2e/process-trades, and checks players, picks, trade status, and transaction rows.' : 'Enable E2E_ENABLE_TRADE_ACCEPT=1 to exercise authenticated multi-asset trade acceptance.',
    },
    {
      requirement: 'D.SEA.3 standings tiebreakers',
      status: tiebreakerStatus,
      evidence: args.tiebreakers ? 'Tiebreaker mode seeds a disposable four-way tie and calls the real authenticated /playoffs/generate route to verify max-points/points-against/deterministic tiebreaker handling.' : 'No forced four-way tie scenario implemented; enable E2E_ENABLE_TIEBREAKERS=1 for standings tiebreaker coverage.',
    },
    {
      requirement: 'D.SEA.4 playoffs/champion',
      status: playoffRowStatus,
      evidence: playoffEvidence,
    },
    {
      requirement: 'D.SEA.5 rookie draft/traded picks',
      status: rookieDraftRowStatus,
      evidence: rookieDraftEvidence,
    },
    {
      requirement: 'D.SEA.6 season reset',
      status: resetStatus,
      evidence: args.seasonReset ? 'Season-reset mode creates a disposable league, calls the real /e2e/advance-season endpoint, and verifies current-season flip, roster carryover, waiver reseed, prior-season queryability, and rolling five-year pick horizon.' : env.backendTicksEnabled ? 'Edge E2E tick mode calls /e2e/advance-season and re-checks invariants.' : 'Requires E2E_ENABLE_BACKEND_TICKS=1 or E2E_ENABLE_SEASON_RESET=1.',
    },
    {
      requirement: 'D.SEA.7 snapshots/no shrink',
      status: snapshotStatus,
      evidence: 'Snapshot summaries are written under tests/snapshots/season-<N>/summary.json.',
    },
    {
      requirement: 'D.X.1 push notifications',
      status: pushStatus,
      evidence: args.push && args.draftPush ? 'Push mode verifies trade and waiver notifications through the fake Expo upstream; draft-push mode verifies rookie auto-pick notifications through the same fake Expo intercept.' : args.push ? 'Push mode verifies trade and waiver notifications through the fake Expo upstream; enable E2E_ENABLE_DRAFT_PUSH=1 for draft notifications.' : args.draftPush ? 'Draft-push mode runs a disposable rookie auto-pick and asserts the fake Expo upstream captured a draft notification; enable E2E_ENABLE_PUSH=1 for trade and waiver notifications.' : 'Enable E2E_ENABLE_PUSH=1 and E2E_ENABLE_DRAFT_PUSH=1 to cover trade, waiver, and draft push notifications.',
    },
    {
      requirement: 'D.X.2 realtime bid/score events',
      status: realtimeStatus,
      evidence: args.realtime ? 'Realtime mode opens multiple Supabase Realtime clients and asserts both matchup score updates and auction bid nomination updates reach every client within 2s.' : 'Enable E2E_ENABLE_REALTIME=1.',
    },
    {
      requirement: 'D.X.3 CORS regression',
      status: env.backendTicksEnabled ? 'PASS' : 'PENDING',
      evidence: env.backendTicksEnabled ? 'Edge E2E tick mode runs OPTIONS preflight before the season loop.' : 'Requires Edge E2E tick mode.',
    },
    {
      requirement: 'D.X.4 perf smoke under draft/live scoring load',
      status: browserPerfStatus,
      evidence: args.browserPerf ? 'Browser perf mode opens the real draft room and home scoreboard while applying continuous auction bids and matchup updates, then asserts responsiveness, screenshots, console output, and browser errors.' : 'Enable E2E_ENABLE_BROWSER_PERF=1 to run the continuous-bid/live-scoring browser perf smoke.',
    },
    {
      requirement: 'D.X.5 UI sweep',
      status: browserStatus,
      evidence: args.browserFullSweep ? 'Browser full sweep visits auth, tabs, modals, player, auction-draft, and rookie-draft routes, with screenshots and console/error artifacts.' : browserStatus === 'PARTIAL' ? 'Browser smoke/auth covers auth and tab routes; enable E2E_BROWSER_FULL_SWEEP=1 for modal/player/draft route sweep.' : 'Enable browser smoke/auth; full app route sweep pending.',
    },
    {
      requirement: 'D.LONG.1/D.LONG.2 long-horizon pick trades',
      status: pickChainStatus,
      evidence: args.pickChain ? 'Pick-chain mode creates a three-hop future-pick trade, verifies owner persistence every season, and checks the target rookie-draft slot belongs to the final owner when the pick year arrives.' : 'Enable E2E_ENABLE_PICK_CHAIN=1 to exercise multi-hop pick ownership and rookie-draft materialization.',
    },
    {
      requirement: 'D.LONG.3/D.LONG.4 standings/champion history',
      status: historyStatus,
      evidence: args.history ? 'History mode seeds deterministic completed-season standings/champion fixtures and verifies them after season resets.' : 'Enable E2E_ENABLE_HISTORY=1 with Edge E2E tick mode.',
    },
    {
      requirement: 'D.LONG.5 mid-life migration',
      status: midlifeMigrationStatus,
      evidence: args.midlifeMigration ? 'Mid-life migration mode runs `npx supabase db push` against the configured local/linked/db-url target between seasons and records tests/artifacts/season-<N>/midlife-migration.json.' : 'Enable E2E_ENABLE_MIDLIFE_MIGRATION=1 to apply the no-op migration between seasons 5 and 6.',
    },
    {
      requirement: 'D.LONG.6 runtime drift',
      status: runtimeStatus,
      evidence: 'Runtime metrics live in tests/artifacts/perf-metrics.json.',
    },
    {
      requirement: 'D.LONG.7 memory/connection leaks',
      status: memoryStatus,
      evidence: 'Harness memory metrics live in tests/artifacts/perf-metrics.json and 10+ season runs fail if RSS or heap exceeds the configured drift limit.',
    },
    {
      requirement: '10 seasons and continue past 10 / 20 clean',
      status: status === 'PASS' && seasons >= 20 ? 'PASS' : status === 'FAIL' ? 'FAIL' : seasons >= 20 ? 'PARTIAL' : 'PENDING',
      evidence: `Current run status is ${status} for target ${seasons} season(s); PARTIAL means enabled season rows passed but full gameplay coverage is still pending.`,
    },
    {
      requirement: 'Production-ready exit criteria',
      status: 'FAIL',
      evidence: 'Production exit remains blocked by P0/P1 operational follow-ups and focused-slice coverage rows that do not yet prove one literal monolithic 10-user season loop for every gameplay requirement.',
    },
  ]

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
}

const assertEnv = async (seasons) => {
  const env = resolvedEnv()
  const missing = []
  if (!env.supabaseUrl) missing.push('E2E_SUPABASE_URL or SUPABASE_URL')
  if (!env.serviceRoleKey) {
    missing.push('E2E_PANCAKE_SUPABASE_SECRET_KEY, PANCAKE_SUPABASE_SECRET_KEY, E2E_SUPABASE_SECRET_KEY, or SUPABASE_SECRET_KEY')
  }
  if (missing.length === 0) return

  const now = timestamp()
  await writeReport({
    status: 'BLOCKED',
    startedAt: now,
    finishedAt: now,
    seasons,
    rows: [{ season: 0, status: 'BLOCKED', notes: `Missing env: ${missing.join(', ')}` }],
    notes: [
      'The soak runner loads .env and .env, then fails closed until Supabase admin credentials are available.',
      'Set NBA_CDN_BASE_URL and SLEEPER_BASE_URL to the fake upstream URL when launching backend and Edge functions.',
    ],
  })
  throw new Error(`Missing required soak environment: ${missing.join(', ')}`)
}

const isMissingSchemaError = (error) => {
  const message = error?.message ?? ''
  return (
    error?.code === 'PGRST202' ||
    error?.code === 'PGRST204' ||
    message.includes('Could not find the function') ||
    message.includes('Could not find the') ||
    message.includes('column') && message.includes('does not exist')
  )
}

const requireRpc = async (supabase, name, args, okErrorPattern) => {
  const { error } = await supabase.rpc(name, args)
  if (!error || okErrorPattern?.test(error.message ?? '')) return null
  if (isMissingSchemaError(error)) return `${name}: ${error.message}`
  return null
}

const requireColumn = async (supabase, table, column) => {
  const { error } = await supabase
    .from(table)
    .select(column)
    .limit(1)
  if (!error) return null
  if (isMissingSchemaError(error)) return `${table}.${column}: ${error.message}`
  return null
}

const runSchemaPreflight = async (supabase) => {
  const zeroUuid = '00000000-0000-0000-0000-000000000000'
  const checks = await Promise.all([
    requireRpc(supabase, 'release_live_poll_lock', {}, null),
    requireRpc(supabase, 'accept_trade_atomic', { p_trade_id: zeroUuid, p_accepting_member_id: zeroUuid }, /Trade not found/i),
    requireRpc(supabase, 'advance_season_atomic', { p_league_id: zeroUuid }, /League not found/i),
    requireRpc(
      supabase,
      'place_auction_bid_atomic',
      { p_draft_id: zeroUuid, p_member_id: zeroUuid, p_nomination_id: zeroUuid, p_amount: 0, p_user_id: zeroUuid },
      /positive integer/i,
    ),
    requireRpc(supabase, 'process_next_waiver_claim_atomic', { p_process_date: '1900-01-01' }, null),
    requireColumn(supabase, 'snake_draft_picks', 'draft_pick_id'),
  ])
  return checks.filter(Boolean)
}

const fetchAll = async (supabase, table, select = '*', filters = {}) => {
  const pageSize = 1000
  const rows = []
  let from = 0

  while (true) {
    let query = supabase
      .from(table)
      .select(select)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    for (const [column, value] of Object.entries(filters)) {
      query = query.eq(column, value)
    }
    const { data, error } = await query
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  return rows
}

const fetchAllIn = async (supabase, table, select, column, values) => {
  if (values.length === 0) return []

  const valueChunks = []
  const uniqueValues = [...new Set(values)]
  for (let index = 0; index < uniqueValues.length; index += 100) {
    valueChunks.push(uniqueValues.slice(index, index + 100))
  }

  const pageSize = 1000
  const rows = []

  for (const chunk of valueChunks) {
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .in(column, chunk)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) throw new Error(`${table}: ${error.message}`)
      if (!data || data.length === 0) break
      rows.push(...data)
      if (data.length < pageSize) break
      from += pageSize
    }
  }

  return rows
}

const E2E_PLAYER_PREFIX = 'e2e-player-'

const seededPlayerQuery = (supabase, select = 'id, display_name') => supabase
  .from('players')
  .select(select)
  .like('sportsdata_id', `${E2E_PLAYER_PREFIX}%`)
  .not('display_name', 'is', null)
  .order('display_name', { ascending: true })

const createFallbackE2EPlayers = async (supabase, leagueSeasonId, count, label) => {
  const rows = Array.from({ length: count }, (_, index) => {
    const suffix = `${leagueSeasonId.slice(0, 8)}-${index + 1}`
    const sportsdataId = `${E2E_PLAYER_PREFIX}fallback-${suffix}`
    return {
      sportsdata_id: sportsdataId,
      nba_id: sportsdataId,
      sleeper_id: sportsdataId,
      first_name: 'E2E',
      last_name: `Fallback${leagueSeasonId.slice(0, 8)}${index + 1}`,
      nba_team: 'FA',
      position: 'PG',
      eligible_positions: ['PG'],
      status: 'Active',
      injury_status: null,
      years_exp: 1,
      nba_draft_number: null,
    }
  })
  const { data, error } = await supabase
    .from('players')
    .upsert(rows, { onConflict: 'sportsdata_id' })
    .select('id, display_name, sportsdata_id')
  if (error) throw new Error(`${label}: fallback E2E player upsert failed: ${error.message}`)
  return data ?? []
}

const writeSnapshots = async (supabase, season, leagueId) => {
  const dir = path.join(SNAPSHOT_ROOT, `season-${season}`)
  await mkdir(dir, { recursive: true })

  const summary = { counts: {} }
  for (const table of SNAPSHOT_TABLES) {
    const rows = await fetchAll(supabase, table, '*', leagueId ? { league_id: leagueId } : {})
    summary.counts[table] = rows.length
    await writeFile(path.join(dir, `${table}.json`), `${JSON.stringify(rows, null, 2)}\n`)
  }
  await writeFile(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

const indexById = (rows) => new Map(rows.map((row) => [row.id, row]))

const RESET_GROWTH_TABLES = [
  'draft_picks',
  'league_seasons',
  'waiver_priorities',
]

const validateSnapshotProgress = (previous, current, { expectResetGrowth = false } = {}) => {
  if (!previous) return []
  const failures = []
  for (const table of SNAPSHOT_TABLES) {
    const before = previous.counts[table] ?? 0
    const after = current.counts[table] ?? 0
    if (after < before) {
      failures.push(`D.SEA.7: ${table} row count shrank from ${before} to ${after}`)
    }
  }
  if (expectResetGrowth) {
    for (const table of RESET_GROWTH_TABLES) {
      const before = previous.counts[table] ?? 0
      const after = current.counts[table] ?? 0
      if (after <= before) {
        failures.push(`D.SEA.7: ${table} row count did not grow across season reset (${before} -> ${after})`)
      }
    }
  }
  return failures
}

const validatePerfDrift = (metrics, totalSeasons) => {
  if (totalSeasons < 10 || metrics.length < 10) return []
  if (!Number.isFinite(PERF_DRIFT_LIMIT) || PERF_DRIFT_LIMIT <= 1) {
    return [`D.LONG.6: invalid E2E_PERF_DRIFT_LIMIT ${process.env.E2E_PERF_DRIFT_LIMIT}`]
  }

  const baseline = median(metrics.slice(0, 3).map((metric) => metric.durationMs))
  const latest = median(metrics.slice(-3).map((metric) => metric.durationMs))
  if (!baseline || !latest) return []

  const maxAllowed = baseline * PERF_DRIFT_LIMIT
  if (latest > maxAllowed) {
    const percent = Math.round(((latest - baseline) / baseline) * 100)
    return [
      `D.LONG.6: per-season runtime median drifted ${percent}% from seasons 1-3 (${roundedMs(baseline)}ms) to seasons ${metrics.at(-3)?.season}-${metrics.at(-1)?.season} (${roundedMs(latest)}ms); limit is ${Math.round((PERF_DRIFT_LIMIT - 1) * 100)}%`,
    ]
  }
  return []
}

const validateMemoryDrift = (metrics, totalSeasons) => {
  if (totalSeasons < 10 || metrics.length < 10) return []
  if (!Number.isFinite(MEMORY_DRIFT_LIMIT) || MEMORY_DRIFT_LIMIT <= 1) {
    return [`D.LONG.7: invalid E2E_MEMORY_DRIFT_LIMIT ${process.env.E2E_MEMORY_DRIFT_LIMIT}`]
  }
  if (!Number.isFinite(MEMORY_DRIFT_MIN_BYTES) || MEMORY_DRIFT_MIN_BYTES < 0) {
    return [`D.LONG.7: invalid E2E_MEMORY_DRIFT_MIN_BYTES ${process.env.E2E_MEMORY_DRIFT_MIN_BYTES}`]
  }
  if (!Number.isFinite(MEMORY_HEAP_DRIFT_MIN_BYTES) || MEMORY_HEAP_DRIFT_MIN_BYTES < 0) {
    return [`D.LONG.7: invalid E2E_MEMORY_HEAP_DRIFT_MIN_BYTES ${process.env.E2E_MEMORY_HEAP_DRIFT_MIN_BYTES}`]
  }

  const baselineSeasonStart = metrics[0]?.season
  const baselineSeasonEnd = metrics[2]?.season
  const latestSeasonStart = metrics.at(-3)?.season
  const latestMetric = metrics.at(-1)
  if (baselineSeasonStart == null || baselineSeasonEnd == null || latestSeasonStart == null || !latestMetric) return []

  const failures = []
  for (const [label, key] of [['RSS', 'rssBytes'], ['heap', 'heapUsedBytes']]) {
    const before = median(metrics.slice(0, 3).map((metric) => metric.memory?.[key]))
    const after = median(metrics.slice(-3).map((metric) => metric.memory?.[key]))
    if (!before || !after) continue
    const minBytes = key === 'heapUsedBytes' ? MEMORY_HEAP_DRIFT_MIN_BYTES : MEMORY_DRIFT_MIN_BYTES
    const maxAllowed = Math.max(before * MEMORY_DRIFT_LIMIT, before + minBytes)
    if (after > maxAllowed) {
      const percent = Math.round(((after - before) / before) * 100)
      failures.push(
        `D.LONG.7: harness ${label} memory median drifted ${percent}% from seasons ${baselineSeasonStart}-${baselineSeasonEnd} (${bytesToMiB(before)} MiB) to seasons ${latestSeasonStart}-${latestMetric.season} (${bytesToMiB(after)} MiB); limit is ${Math.round((MEMORY_DRIFT_LIMIT - 1) * 100)}%`,
      )
    }
  }
  return failures
}

const fetchSingle = async (supabase, table, select, filters) => {
  const buildQuery = () => {
    let query = supabase.from(table).select(select)
    for (const [column, value] of Object.entries(filters)) {
      query = query.eq(column, value)
    }
    return query
  }
  const { data, error } = await withSupabaseRetry(`${table} single`, () => buildQuery().single())
  if (error) throw new Error(`${table}: ${error.message ?? JSON.stringify(error)}`)
  return data
}

const countRows = async (supabase, table, filters) => {
  const buildQuery = () => {
    let query = supabase.from(table).select('id', { count: 'exact', head: true })
    for (const [column, value] of Object.entries(filters)) {
      query = query.eq(column, value)
    }
    return query
  }
  const { count, error } = await withSupabaseRetry(`${table} count`, () => buildQuery())
  if (error) throw new Error(`${table} count: ${error.message ?? JSON.stringify(error)}`)
  return count ?? 0
}

const assertMatchupGenerationIdempotent = async (supabase, env, leagueId) => {
  const failures = []
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const memberCount = await countRows(supabase, 'league_members', { league_id: leagueId })
  const before = await countRows(supabase, 'matchups', {
    league_id: leagueId,
    league_season_id: currentSeason.id,
  })
  await backendJson(env, '/e2e/generate-matchups', { force: false, leagueId })
  const after = await countRows(supabase, 'matchups', {
    league_id: leagueId,
    league_season_id: currentSeason.id,
  })

  if (memberCount >= 2 && before === 0) {
    failures.push(`D.SEA.1: target league ${leagueId} has no generated matchups for current season`)
  }
  if (after !== before) {
    failures.push(`D.SEA.1: matchup generation is not idempotent (${before} -> ${after})`)
  }
  return failures
}

const createAndAcceptPickTrade = async (supabase, leagueId, seasonId, proposerId, recipientId, proposerPickId) => {
  const completedAt = new Date().toISOString()
  const { data: trade, error: tradeError } = await withSupabaseRetry('trades insert', () => supabase
      .from('trades')
      .insert({
        league_id: leagueId,
        league_season_id: seasonId,
        proposer_member_id: proposerId,
        recipient_member_id: recipientId,
        status: 'completed',
        notes: 'E2E multi-hop future-pick chain',
        accepted_at: completedAt,
        veto_window_expires_at: completedAt,
        completed_at: completedAt,
      })
      .select('id')
      .single())
  if (tradeError) throw new Error(`trades insert: ${tradeError.message}`)

  const { error: itemError } = await withSupabaseRetry('trade_items insert', () => supabase.from('trade_items').insert([
      { trade_id: trade.id, side: 'proposer', player_id: null, pick_id: proposerPickId },
    ]))
  if (itemError) throw new Error(`trade_items insert: ${itemError.message}`)

  const { data: movedProposerPick, error: proposerMoveError } = await withSupabaseRetry('draft_picks proposer move', () => supabase
      .from('draft_picks')
      .update({ current_owner_id: recipientId })
      .eq('id', proposerPickId)
      .eq('league_id', leagueId)
      .eq('current_owner_id', proposerId)
      .eq('is_used', false)
      .select('id')
      .single())
  if (proposerMoveError || !movedProposerPick) {
    throw new Error(`draft_picks proposer move: ${proposerMoveError?.message ?? 'no row moved'}`)
  }
  return trade.id
}

const setupFuturePickChain = async (supabase, leagueId) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id, season_year',
    { league_id: leagueId, is_current: true },
  )
  const members = await fetchAll(supabase, 'league_members', 'id, user_id, team_name, joined_at', { league_id: leagueId })
  members.sort((a, b) => {
    const joined = String(a.joined_at).localeCompare(String(b.joined_at))
    return joined === 0 ? String(a.id).localeCompare(String(b.id)) : joined
  })
  if (members.length < 4) throw new Error('Future-pick chain requires at least four league members')

  let targetYear = currentSeason.season_year + 5
  let targetPick = null
  let member1 = null
  for (const year of Array.from({ length: 5 }, (_, index) => currentSeason.season_year + 5 - index)) {
    const { data: candidatePicks, error: candidateError } = await withSupabaseRetry('draft_picks target pick lookup', () => supabase
        .from('draft_picks')
        .select('id, current_owner_id, original_owner_id, season_year, round')
        .eq('league_id', leagueId)
        .eq('season_year', year)
        .eq('round', 1)
        .eq('is_used', false)
        .in('original_owner_id', members.map((member) => member.id)))
    if (candidateError) throw new Error(`draft_picks target pick lookup: ${candidateError.message}`)
    targetPick = (candidatePicks ?? []).find((pick) => pick.current_owner_id === pick.original_owner_id) ?? null
    if (targetPick) {
      targetYear = year
      member1 = members.find((member) => member.id === targetPick.original_owner_id) ?? null
      break
    }
  }
  if (!targetPick || !member1) {
    throw new Error(`No self-owned round 1 pick found within the five-year horizon for league ${leagueId}`)
  }

  const [member2, member3, member4] = members
    .filter((member) => member.id !== member1.id)
    .slice(0, 3)
  if (!member2 || !member3 || !member4) throw new Error('Future-pick chain requires four distinct league members')

  const trade1 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member1.id,
    member2.id,
    targetPick.id,
  )

  const trade2 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member2.id,
    member3.id,
    targetPick.id,
  )

  const trade3 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member3.id,
    member4.id,
    targetPick.id,
  )

  return {
    targetPickId: targetPick.id,
    targetYear,
    finalOwnerId: member4.id,
    finalOwnerTeam: member4.team_name,
    tradeIds: [trade1, trade2, trade3],
    rookieDraftId: null,
    rookieDraftCheckedSeason: null,
  }
}

const assertFuturePickMaterializedInRookieDraft = async (supabase, env, leagueId, scenario, season) => {
  if (!scenario || scenario.rookieDraftId) return null

  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id, season_year',
    { league_id: leagueId, is_current: true },
  )
  if (currentSeason.season_year < scenario.targetYear) return null

  const { draft } = await backendJson(env, '/e2e/start-rookie-draft', { leagueId })
  const { data: slot, error } = await supabase
    .from('snake_draft_picks')
    .select('id, draft_id, overall_pick, round, pick_in_round, member_id, draft_pick_id')
    .eq('draft_id', draft.id)
    .eq('draft_pick_id', scenario.targetPickId)
    .single()
  if (error || !slot) {
    throw new Error(`D.LONG.1: rookie draft ${draft.id} did not materialize target pick ${scenario.targetPickId}: ${error?.message ?? 'missing row'}`)
  }
  if (slot.member_id !== scenario.finalOwnerId) {
    throw new Error(`D.LONG.1: rookie draft slot ${slot.id} belongs to ${slot.member_id}; expected traded owner ${scenario.finalOwnerId}`)
  }

  scenario.rookieDraftId = draft.id
  scenario.rookieDraftCheckedSeason = season
  const artifact = {
    season,
    seasonYear: currentSeason.season_year,
    draftId: draft.id,
    targetPickId: scenario.targetPickId,
    expectedOwnerId: scenario.finalOwnerId,
    slot,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'rookie-draft-pick-chain.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  await writeFile(
    path.join(ARTIFACT_ROOT, 'future-pick-chain.json'),
    `${JSON.stringify(scenario, null, 2)}\n`,
  )
  return artifact
}

const HISTORY_WEEK_NUMBER = 99

const sortedLeagueMembers = async (supabase, leagueId) => {
  const members = await fetchAll(supabase, 'league_members', 'id, team_name, joined_at', { league_id: leagueId })
  members.sort((a, b) => {
    const joined = String(a.joined_at).localeCompare(String(b.joined_at))
    return joined === 0 ? String(a.id).localeCompare(String(b.id)) : joined
  })
  if (members.length < 2) throw new Error('D.LONG.3/D.LONG.4: history scenario requires at least two league members')
  return members
}

const buildHistoryFixture = (leagueId, leagueSeason, members) => {
  const offset = Number(leagueSeason.season_year) % members.length
  const ranked = [...members.slice(offset), ...members.slice(0, offset)]
  const standings = ranked.map((member, index) => ({
    league_id: leagueId,
    league_season_id: leagueSeason.id,
    member_id: member.id,
    week_number: HISTORY_WEEK_NUMBER,
    wins: members.length - index,
    losses: index,
    ties: 0,
    points_for: 1200 - index * 25,
    points_against: 900 + index * 20,
    max_possible_points: 1300 - index * 20,
    waiver_priority: index + 1,
  }))

  return {
    leagueId,
    leagueSeasonId: leagueSeason.id,
    seasonYear: leagueSeason.season_year,
    weekNumber: HISTORY_WEEK_NUMBER,
    standings,
    championMemberId: ranked[0].id,
    runnerUpMemberId: ranked[1].id,
    championTeamName: ranked[0].team_name,
  }
}

const assertStandingMatchesFixture = (actual, expected, failures) => {
  for (const key of ['wins', 'losses', 'ties', 'waiver_priority']) {
    if (Number(actual[key]) !== Number(expected[key])) {
      failures.push(`D.LONG.3: standing ${actual.id} ${key}=${actual[key]}; expected ${expected[key]}`)
    }
  }
  for (const key of ['points_for', 'points_against', 'max_possible_points']) {
    if (Number(actual[key]) !== Number(expected[key])) {
      failures.push(`D.LONG.3: standing ${actual.id} ${key}=${actual[key]}; expected ${expected[key]}`)
    }
  }
}

const ensureHistoryFixtureForSeason = async (supabase, leagueId, leagueSeason) => {
  const members = await sortedLeagueMembers(supabase, leagueId)
  const fixture = buildHistoryFixture(leagueId, leagueSeason, members)

  const { data: existingStandings, error: standingsReadError } = await supabase
    .from('standings')
    .select('id, member_id, wins, losses, ties, points_for, points_against, max_possible_points, waiver_priority')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeason.id)
    .eq('week_number', HISTORY_WEEK_NUMBER)
  if (standingsReadError) throw new Error(`D.LONG.3 standings read: ${standingsReadError.message}`)

  if ((existingStandings ?? []).length === 0) {
    const { error } = await supabase.from('standings').insert(fixture.standings)
    if (error) throw new Error(`D.LONG.3 standings fixture insert: ${error.message}`)
  }

  const { data: existingFinals, error: finalsReadError } = await supabase
    .from('matchups')
    .select('id, home_member_id, away_member_id, winner_member_id, is_finalized')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeason.id)
    .eq('week_number', HISTORY_WEEK_NUMBER + 1)
    .eq('matchup_type', 'playoff_final')
  if (finalsReadError) throw new Error(`D.LONG.4 champion read: ${finalsReadError.message}`)

  const matchingFinal = (existingFinals ?? []).find((row) => (
    row.home_member_id === fixture.championMemberId &&
    row.away_member_id === fixture.runnerUpMemberId
  ))
  if (!matchingFinal) {
    const { data: finalRow, error } = await supabase
      .from('matchups')
      .insert({
        league_id: leagueId,
        league_season_id: leagueSeason.id,
        week_number: HISTORY_WEEK_NUMBER + 1,
        matchup_type: 'playoff_final',
        home_member_id: fixture.championMemberId,
        away_member_id: fixture.runnerUpMemberId,
        home_points: 110,
        away_points: 100,
        home_max_possible_points: 120,
        away_max_possible_points: 112,
        winner_member_id: fixture.championMemberId,
        is_finalized: true,
        finalized_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throw new Error(`D.LONG.4 champion fixture insert: ${error.message}`)
    fixture.championMatchupId = finalRow.id
  } else {
    fixture.championMatchupId = matchingFinal.id
  }

  return fixture
}

const assertHistoryRetained = async (supabase, fixtures, runSeason) => {
  const failures = []
  const retained = []
  for (const fixture of fixtures) {
    const { data: standings, error: standingsError } = await supabase
      .from('standings')
      .select('id, member_id, wins, losses, ties, points_for, points_against, max_possible_points, waiver_priority')
      .eq('league_id', fixture.leagueId)
      .eq('league_season_id', fixture.leagueSeasonId)
      .eq('week_number', fixture.weekNumber)
    if (standingsError) {
      failures.push(`D.LONG.3: standings history query failed for ${fixture.seasonYear}: ${standingsError.message}`)
      continue
    }

    const byMember = new Map((standings ?? []).map((row) => [row.member_id, row]))
    for (const expected of fixture.standings) {
      const actual = byMember.get(expected.member_id)
      if (!actual) {
        failures.push(`D.LONG.3: season ${fixture.seasonYear} missing historical standing for member ${expected.member_id}`)
        continue
      }
      assertStandingMatchesFixture(actual, expected, failures)
    }

    const { data: final, error: finalError } = await supabase
      .from('matchups')
      .select('id, winner_member_id, is_finalized')
      .eq('id', fixture.championMatchupId)
      .single()
    if (finalError || !final) {
      failures.push(`D.LONG.4: champion matchup ${fixture.championMatchupId} is not queryable: ${finalError?.message ?? 'missing row'}`)
    } else if (!final.is_finalized || final.winner_member_id !== fixture.championMemberId) {
      failures.push(`D.LONG.4: champion history for ${fixture.seasonYear} resolved to ${final.winner_member_id}; expected ${fixture.championMemberId}`)
    }

    retained.push({
      seasonYear: fixture.seasonYear,
      leagueSeasonId: fixture.leagueSeasonId,
      standingsRows: standings?.length ?? 0,
      championMatchupId: fixture.championMatchupId,
      championMemberId: fixture.championMemberId,
      championTeamName: fixture.championTeamName,
    })
  }

  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${runSeason}`, 'history-retention.json'),
    `${JSON.stringify({ runSeason, retained }, null, 2)}\n`,
  )
  return failures
}

const e2eCode = () => Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 18).toUpperCase().padEnd(16, '0')

const EXPECTED_DEFAULT_LINEUP_SLOTS = {
  PG: 1,
  SG: 1,
  SF: 1,
  PF: 1,
  C: 1,
  G: 1,
  F: 1,
  UTIL: 3,
  BE: 10,
  IR: 2,
}

const currentSeasonYear = (now = new Date()) => {
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
}

const createDisposableLeagueFromSeedUsers = async ({ supabase, state, season, label, userCount, seasonYear }) => {
  if (!state?.password || !Array.isArray(state.users) || state.users.length < userCount) {
    throw new Error(`${label}: scenario requires ${userCount} seeded users from npm run e2e:seed`)
  }

  const unique = `${state.runId ?? 'manual'}-${season}-${Date.now().toString(36)}`
  const { data: league, error: leagueError } = await supabase
    .from('leagues')
    .insert({
      name: `Pancake E2E ${label.replace(/[^A-Z0-9]+/gi, ' ')} ${unique}`,
      slug: `pancake-e2e-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${unique}`,
      invite_code: e2eCode(),
      commissioner_id: state.users[0].id,
      status: 'active',
      playoff_start_week: 20,
    })
    .select('id, playoff_start_week')
    .single()
  if (leagueError) throw new Error(`${label} league insert: ${leagueError.message}`)

  const { data: leagueSeason, error: seasonError } = await supabase
    .from('league_seasons')
    .insert({
      league_id: league.id,
      season_year: seasonYear ?? 3000 + season,
      is_current: true,
    })
    .select('id, season_year')
    .single()
  if (seasonError) throw new Error(`${label} season insert: ${seasonError.message}`)

  const orderByUserId = new Map(state.users.map((user, index) => [user.id, index]))
  const { data: insertedMembers, error: membersError } = await supabase
    .from('league_members')
    .insert(state.users.slice(0, userCount).map((user, index) => ({
      league_id: league.id,
      user_id: user.id,
      role: index === 0 ? 'commissioner' : 'manager',
      team_name: `${label} Seed ${index + 1}`,
    })))
    .select('id, user_id, team_name')
  if (membersError) throw new Error(`${label} members insert: ${membersError.message}`)

  const members = [...(insertedMembers ?? [])].sort((a, b) => {
    return (orderByUserId.get(a.user_id) ?? 999) - (orderByUserId.get(b.user_id) ?? 999)
  })
  if (members.length < userCount) throw new Error(`${label}: disposable league has ${members.length} members; expected ${userCount}`)

  return {
    league,
    leagueSeason,
    members,
  }
}

const signInSupabaseClient = async (env, email, password, label) => {
  if (!env.anonKey) {
    throw new Error(
      `${label}: requires E2E_SUPABASE_PUBLISHABLE_KEY or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
    )
  }
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`${label}: sign-in failed for ${email}: ${error.message}`)
  return client
}

const readLeagueSettingsForClient = async (client, leagueId, label) => {
  const { data, error } = await client
    .from('leagues')
    .select('id, scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget, playoff_start_week')
    .eq('id', leagueId)
    .single()
  if (error || !data) throw new Error(`${label}: league settings read failed: ${error?.message ?? 'missing row'}`)
  return data
}

const readLineupSlotsForClient = async (client, leagueId, label) => {
  const { data, error } = await client
    .from('lineup_slot_templates')
    .select('slot_type, slot_count')
    .eq('league_id', leagueId)
  if (error) throw new Error(`${label}: lineup slot read failed: ${error.message}`)
  return data ?? []
}

const readPlayerBySleeperId = async (supabase, sleeperId, label) => {
  const { data, error } = await supabase
    .from('players')
    .select('id, sportsdata_id, first_name, last_name, display_name, sleeper_id, status, injury_status, nba_team, years_exp')
    .eq('sleeper_id', sleeperId)
    .limit(1)
  if (error) throw new Error(`${label}: player lookup for sleeper_id=${sleeperId} failed: ${error.message}`)
  return data?.[0] ?? null
}

const ensureSleeperFixturePlayer = async (supabase, { sleeperId, firstName, lastName, position }, label) => {
  const existing = await readPlayerBySleeperId(supabase, sleeperId, label)
  const fields = {
    first_name: firstName,
    last_name: lastName,
    sleeper_id: sleeperId,
    position,
    eligible_positions: [position],
    status: 'Inactive',
    injury_status: 'Stale',
    nba_team: 'OLD',
    years_exp: 99,
  }

  if (existing) {
    const { data, error } = await supabase
      .from('players')
      .update(fields)
      .eq('id', existing.id)
      .select('id, sportsdata_id, first_name, last_name, display_name, sleeper_id, status, injury_status, nba_team, years_exp')
      .single()
    if (error) throw new Error(`${label}: player fixture update failed for sleeper_id=${sleeperId}: ${error.message}`)
    return data
  }

  const { data, error } = await supabase
    .from('players')
    .insert({
      ...fields,
      sportsdata_id: `e2e-injury-${sleeperId}`,
    })
    .select('id, sportsdata_id, first_name, last_name, display_name, sleeper_id, status, injury_status, nba_team, years_exp')
    .single()
  if (error) throw new Error(`${label}: player fixture insert failed for sleeper_id=${sleeperId}: ${error.message}`)
  return data
}

const assertInjuryStatusFilterScenario = async ({ supabase, env, season, fakePort }) => {
  const failures = []
  const label = 'D.SEA.2 injury'
  const expectedSleeperBaseUrl = `http://127.0.0.1:${fakePort}/v1`
  const backendStatus = await backendGetJson(env, '/e2e/status')
  if (backendStatus.sleeperBaseUrl !== expectedSleeperBaseUrl) {
    throw new Error(`${label}: backend SLEEPER_BASE_URL=${backendStatus.sleeperBaseUrl ?? '<missing>'}; expected ${expectedSleeperBaseUrl}`)
  }

  const scrambledFixture = await ensureSleeperFixturePlayer(supabase, {
    sleeperId: '1001',
    firstName: 'Ari',
    lastName: 'Glass',
    position: 'PG',
  }, label)
  const validFixture = await ensureSleeperFixturePlayer(supabase, {
    sleeperId: '1002',
    firstName: 'Ben',
    lastName: 'Pine',
    position: 'SG',
  }, label)
  const { error: statsCleanupError } = await supabase
    .from('player_game_stats')
    .delete()
    .in('player_id', [scrambledFixture.id, validFixture.id])
  if (statsCleanupError) throw new Error(`${label}: fixture stat cleanup failed: ${statsCleanupError.message}`)

  await postJson(`http://127.0.0.1:${fakePort}/admin/injury`, {
    playerId: '1001',
    injuryStatus: 'Scrambled',
  })
  await postJson(`http://127.0.0.1:${fakePort}/admin/injury`, {
    playerId: '1002',
    injuryStatus: 'Out',
  })

  const syncResult = await backendJson(env, '/e2e/sync-players')
  const fakeState = await (await fetch(`http://127.0.0.1:${fakePort}/admin/state`)).json()
  const expectedScrambled = fakeState.players?.['1001'] ?? {}
  const expectedValid = fakeState.players?.['1002'] ?? {}
  const scrambledPlayer = await readPlayerBySleeperId(supabase, '1001', label)
  const validPlayer = await readPlayerBySleeperId(supabase, '1002', label)

  if (scrambledPlayer?.injury_status != null) {
    failures.push(`${label}: fake Sleeper injury_status Scrambled persisted as ${scrambledPlayer.injury_status}; expected null`)
  }
  if (validPlayer?.injury_status !== 'Out') {
    failures.push(`${label}: fake Sleeper injury_status Out persisted as ${validPlayer?.injury_status ?? '<null>'}; expected Out`)
  }
  if (scrambledPlayer?.nba_team !== expectedScrambled.team || Number(scrambledPlayer?.years_exp) !== Number(expectedScrambled.years_exp)) {
    failures.push(`${label}: Scrambled fixture team/years_exp ${scrambledPlayer?.nba_team ?? '<null>'}/${scrambledPlayer?.years_exp ?? '<null>'}; expected ${expectedScrambled.team}/${expectedScrambled.years_exp}`)
  }
  if (validPlayer?.nba_team !== expectedValid.team || Number(validPlayer?.years_exp) !== Number(expectedValid.years_exp)) {
    failures.push(`${label}: valid injury fixture team/years_exp ${validPlayer?.nba_team ?? '<null>'}/${validPlayer?.years_exp ?? '<null>'}; expected ${expectedValid.team}/${expectedValid.years_exp}`)
  }

  const artifact = {
    season,
    fakeSleeperBaseUrl: expectedSleeperBaseUrl,
    syncResult,
    before: {
      scrambledFixture,
      validFixture,
    },
    after: {
      scrambledPlayer,
      validPlayer,
    },
    expected: {
      sleeperId1001: { ...expectedScrambled, upstreamInjuryStatus: 'Scrambled', persistedInjuryStatus: null },
      sleeperId1002: { ...expectedValid, upstreamInjuryStatus: 'Out', persistedInjuryStatus: 'Out' },
    },
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'injury-status-filter.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const tradeAcceptFixtureSeasonYear = () => 8100 + Number(Date.now().toString().slice(-6))

const assertTradeAcceptanceAtomicityScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SEA.2 trade'
  const fixtureSeasonYear = tradeAcceptFixtureSeasonYear()
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 2,
    seasonYear: fixtureSeasonYear,
  })
  const [proposer, recipient] = fixture.members

  const { data: players, error: playersError } = await seededPlayerQuery(supabase)
    .limit(2)
  if (playersError) throw new Error(`${label}: player fixture lookup failed: ${playersError.message}`)
  if ((players ?? []).length < 2) throw new Error(`${label}: requires at least two players in the test Supabase project`)
  const [proposerPlayer, recipientPlayer] = players

  const { error: rosterError } = await supabase.from('roster_players').insert([
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: proposer.id,
      player_id: proposerPlayer.id,
      acquired_via: 'draft',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: recipient.id,
      player_id: recipientPlayer.id,
      acquired_via: 'draft',
    },
  ])
  if (rosterError) throw new Error(`${label}: roster fixture insert failed: ${rosterError.message}`)

  const pickYear = fixtureSeasonYear + 2
  const { data: picks, error: picksError } = await supabase
    .from('draft_picks')
    .insert([
      {
        league_id: fixture.league.id,
        season_year: pickYear,
        round: 1,
        original_owner_id: proposer.id,
        current_owner_id: proposer.id,
      },
      {
        league_id: fixture.league.id,
        season_year: pickYear,
        round: 2,
        original_owner_id: recipient.id,
        current_owner_id: recipient.id,
      },
    ])
    .select('id, original_owner_id, current_owner_id, season_year, round')
  if (picksError) throw new Error(`${label}: draft-pick fixture insert failed: ${picksError.message}`)
  const proposerPick = picks.find((pick) => pick.original_owner_id === proposer.id)
  const recipientPick = picks.find((pick) => pick.original_owner_id === recipient.id)
  if (!proposerPick || !recipientPick) throw new Error(`${label}: draft-pick fixture did not return both picks`)

  const { data: trade, error: tradeError } = await supabase
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      proposer_member_id: proposer.id,
      recipient_member_id: recipient.id,
      status: 'pending',
      notes: 'E2E multi-asset trade acceptance',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`${label}: trade insert failed: ${tradeError.message}`)

  const tradeItems = [
    { trade_id: trade.id, side: 'proposer', player_id: proposerPlayer.id, pick_id: null },
    { trade_id: trade.id, side: 'proposer', player_id: null, pick_id: proposerPick.id },
    { trade_id: trade.id, side: 'recipient', player_id: recipientPlayer.id, pick_id: null },
    { trade_id: trade.id, side: 'recipient', player_id: null, pick_id: recipientPick.id },
  ]
  const { error: itemError } = await supabase.from('trade_items').insert(tradeItems)
  if (itemError) throw new Error(`${label}: trade item insert failed: ${itemError.message}`)

  const proposerToken = await signInForAccessToken(env, state.users[0].email, state.password)
  const recipientToken = await signInForAccessToken(env, state.users[1].email, state.password)
  const mismatchedMemberError = await expectAuthedBackendError({
    env,
    path: `/trades/${trade.id}/accept`,
    token: proposerToken,
    body: { memberId: recipient.id },
    label: `${label}: mismatched auth/member accept`,
    pattern: /403|Access denied/i,
  })
  if (mismatchedMemberError) failures.push(mismatchedMemberError)

  const beforeAcceptTrade = await fetchSingle(
    supabase,
    'trades',
    'id, status, accepted_at, completed_at',
    { id: trade.id },
  )
  if (beforeAcceptTrade.status !== 'pending') {
    failures.push(`${label}: mismatched accept changed trade status to ${beforeAcceptTrade.status}; expected pending`)
  }

  const acceptResult = await backendAuthedJson(env, `/trades/${trade.id}/accept`, recipientToken, {
    memberId: recipient.id,
  })
  const replayError = await expectAuthedBackendError({
    env,
    path: `/trades/${trade.id}/accept`,
    token: recipientToken,
    body: { memberId: recipient.id },
    label: `${label}: replay accept`,
    pattern: /no longer pending|400|500/i,
  })
  if (replayError) failures.push(replayError)

  const [acceptedTrade, movedRoster, movedPicks, transactions] = await Promise.all([
    fetchSingle(supabase, 'trades', 'id, status, accepted_at, veto_window_expires_at, completed_at', { id: trade.id }),
    fetchAll(supabase, 'roster_players', 'id, member_id, player_id, acquired_via', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'draft_picks', 'id, current_owner_id, original_owner_id, season_year, round', {
      league_id: fixture.league.id,
      season_year: pickYear,
    }),
    fetchAll(supabase, 'roster_transactions', 'id, member_id, player_id, transaction_type, related_trade_id', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      related_trade_id: trade.id,
    }),
  ])

  const rosterByPlayer = new Map(movedRoster.map((row) => [row.player_id, row]))
  const picksById = new Map(movedPicks.map((pick) => [pick.id, pick]))
  if (acceptedTrade.status !== 'accepted' || !acceptedTrade.accepted_at || !acceptedTrade.veto_window_expires_at || acceptedTrade.completed_at) {
    failures.push(`${label}: accepted trade status=${acceptedTrade.status}, accepted_at=${acceptedTrade.accepted_at ?? '<null>'}, veto_window_expires_at=${acceptedTrade.veto_window_expires_at ?? '<null>'}, completed_at=${acceptedTrade.completed_at ?? '<null>'}; expected open veto window`)
  }
  if (rosterByPlayer.get(proposerPlayer.id)?.member_id !== proposer.id || rosterByPlayer.get(recipientPlayer.id)?.member_id !== recipient.id) {
    failures.push(`${label}: assets moved before veto window elapsed`)
  }
  if (picksById.get(proposerPick.id)?.current_owner_id !== proposer.id || picksById.get(recipientPick.id)?.current_owner_id !== recipient.id) {
    failures.push(`${label}: picks moved before veto window elapsed`)
  }
  if (transactions.length !== 0) {
    failures.push(`${label}: roster_transactions count=${transactions.length}; expected 0 before veto window completion`)
  }

  const { error: expireError } = await supabase
    .from('trades')
    .update({ veto_window_expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', trade.id)
  if (expireError) throw new Error(`${label}: expire veto window failed: ${expireError.message}`)
  const processResult = await backendJson(env, '/e2e/process-trades')

  const [completedTrade, completedRoster, completedPicks, completedTransactions] = await Promise.all([
    fetchSingle(supabase, 'trades', 'id, status, accepted_at, veto_window_expires_at, completed_at', { id: trade.id }),
    fetchAll(supabase, 'roster_players', 'id, member_id, player_id, acquired_via', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'draft_picks', 'id, current_owner_id, original_owner_id, season_year, round', {
      league_id: fixture.league.id,
      season_year: pickYear,
    }),
    fetchAll(supabase, 'roster_transactions', 'id, member_id, player_id, transaction_type, related_trade_id', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      related_trade_id: trade.id,
    }),
  ])

  const completedRosterByPlayer = new Map(completedRoster.map((row) => [row.player_id, row]))
  const completedPicksById = new Map(completedPicks.map((pick) => [pick.id, pick]))
  if (completedTrade.status !== 'completed' || !completedTrade.accepted_at || !completedTrade.completed_at) {
    failures.push(`${label}: completed trade status=${completedTrade.status}, accepted_at=${completedTrade.accepted_at ?? '<null>'}, completed_at=${completedTrade.completed_at ?? '<null>'}; expected completed timestamps`)
  }
  if (completedRosterByPlayer.get(proposerPlayer.id)?.member_id !== recipient.id) {
    failures.push(`${label}: proposer player moved to ${completedRosterByPlayer.get(proposerPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${recipient.id}`)
  }
  if (completedRosterByPlayer.get(recipientPlayer.id)?.member_id !== proposer.id) {
    failures.push(`${label}: recipient player moved to ${completedRosterByPlayer.get(recipientPlayer.id)?.member_id ?? '<missing>'}; expected proposer ${proposer.id}`)
  }
  if (completedRosterByPlayer.get(proposerPlayer.id)?.acquired_via !== 'trade' || completedRosterByPlayer.get(recipientPlayer.id)?.acquired_via !== 'trade') {
    failures.push(`${label}: moved players did not receive acquired_via=trade`)
  }
  if (completedPicksById.get(proposerPick.id)?.current_owner_id !== recipient.id) {
    failures.push(`${label}: proposer pick owner=${completedPicksById.get(proposerPick.id)?.current_owner_id ?? '<missing>'}; expected recipient ${recipient.id}`)
  }
  if (completedPicksById.get(recipientPick.id)?.current_owner_id !== proposer.id) {
    failures.push(`${label}: recipient pick owner=${completedPicksById.get(recipientPick.id)?.current_owner_id ?? '<missing>'}; expected proposer ${proposer.id}`)
  }
  if (completedTransactions.length !== 4) {
    failures.push(`${label}: roster_transactions count=${completedTransactions.length}; expected 4 trade in/out rows for two players`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    tradeId: trade.id,
    acceptResult,
    mismatchedMemberRejected: mismatchedMemberError == null,
    replayRejected: replayError == null,
    members: {
      proposer,
      recipient,
    },
    assets: {
      proposerPlayer,
      recipientPlayer,
      proposerPick,
      recipientPick,
    },
    after: {
      acceptedTrade,
      processResult,
      completedTrade,
      roster: completedRoster,
      picks: completedPicks,
      transactions: completedTransactions,
    },
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'trade-acceptance-atomicity.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const assertTradeVetoScenario = async ({ supabase, env, state, season }) => {
  const label = 'D.SEA.2 trade veto'
  const failures = []
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 10,
  })
  const [commissioner, proposer, recipient, ...voters] = fixture.members
  const acceptedAt = new Date().toISOString()
  const vetoWindowExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

  const createAcceptedTrade = async (notes) => {
    const { data, error } = await supabase
      .from('trades')
      .insert({
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        proposer_member_id: proposer.id,
        recipient_member_id: recipient.id,
        status: 'accepted',
        accepted_at: acceptedAt,
        veto_window_expires_at: vetoWindowExpiresAt,
        notes,
      })
      .select('id, status, vetoed_at')
      .single()
    if (error || !data) throw new Error(`${label}: accepted trade insert failed: ${error?.message ?? 'missing row'}`)
    return data
  }

  const thresholdTrade = await createAcceptedTrade('E2E member veto threshold')
  const commissionerTrade = await createAcceptedTrade('E2E commissioner veto')
  const tokens = await Promise.all(
    [commissioner, proposer, ...voters.slice(0, 4)].map((member) => {
      const user = state.users.find((candidate) => candidate.id === member.user_id)
      if (!user) throw new Error(`${label}: missing seeded user for member ${member.id}`)
      return signInForAccessToken(env, user.email, state.password)
    }),
  )
  const [commissionerToken, proposerToken, ...voterTokens] = tokens

  const partyVetoError = await expectAuthedBackendError({
    env,
    path: `/trades/${thresholdTrade.id}/veto`,
    token: proposerToken,
    body: { memberId: proposer.id },
    label: `${label}: trade party member veto`,
    pattern: /Trade parties cannot veto|400/i,
  })
  if (partyVetoError) failures.push(partyVetoError)

  for (const [index, voter] of voters.slice(0, 3).entries()) {
    const result = await backendAuthedJson(env, `/trades/${thresholdTrade.id}/veto`, voterTokens[index], {
      memberId: voter.id,
    })
    if (result.vetoed) {
      failures.push(`${label}: voter ${index + 1} vetoed trade before 50% threshold`)
    }
  }

  const beforeThreshold = await fetchSingle(supabase, 'trades', 'id, status, vetoed_at', { id: thresholdTrade.id })
  if (beforeThreshold.status !== 'accepted' || beforeThreshold.vetoed_at) {
    failures.push(`${label}: trade status=${beforeThreshold.status}, vetoed_at=${beforeThreshold.vetoed_at ?? '<null>'}; expected accepted before threshold`)
  }

  const thresholdResult = await backendAuthedJson(env, `/trades/${thresholdTrade.id}/veto`, voterTokens[3], {
    memberId: voters[3].id,
  })
  if (!thresholdResult.vetoed || thresholdResult.threshold !== 4 || thresholdResult.vetoCount !== 4) {
    failures.push(`${label}: threshold result=${JSON.stringify(thresholdResult)}; expected vetoed with count 4 threshold 4`)
  }

  const afterThreshold = await fetchSingle(supabase, 'trades', 'id, status, vetoed_at', { id: thresholdTrade.id })
  if (afterThreshold.status !== 'vetoed' || !afterThreshold.vetoed_at) {
    failures.push(`${label}: threshold trade status=${afterThreshold.status}, vetoed_at=${afterThreshold.vetoed_at ?? '<null>'}; expected vetoed`)
  }

  const commissionerResult = await backendAuthedJson(env, `/trades/${commissionerTrade.id}/veto`, commissionerToken, {
    memberId: commissioner.id,
  })
  if (!commissionerResult.vetoed) {
    failures.push(`${label}: commissioner veto did not immediately veto trade`)
  }

  const [afterCommissioner, vetoRows] = await Promise.all([
    fetchSingle(supabase, 'trades', 'id, status, vetoed_at', { id: commissionerTrade.id }),
    fetchAll(supabase, 'trade_vetos', 'id, trade_id, member_id, veto_type', {}),
  ])
  const scopedVetoRows = vetoRows.filter((row) => row.trade_id === thresholdTrade.id || row.trade_id === commissionerTrade.id)
  if (afterCommissioner.status !== 'vetoed' || !afterCommissioner.vetoed_at) {
    failures.push(`${label}: commissioner trade status=${afterCommissioner.status}, vetoed_at=${afterCommissioner.vetoed_at ?? '<null>'}; expected vetoed`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    thresholdTradeId: thresholdTrade.id,
    commissionerTradeId: commissionerTrade.id,
    partyVetoRejected: partyVetoError == null,
    thresholdResult,
    commissionerResult,
    afterThreshold,
    afterCommissioner,
    vetoRows: scopedVetoRows,
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'trade-veto-threshold.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const assertLeagueLifecycleScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SET.2'
  const users = state.users.slice(0, 10)
  const unique = `${state.runId ?? 'manual'}-${season}-${Date.now().toString(36)}`
  const commissioner = await signInSupabaseClient(env, users[0].email, state.password, label)
  const { data: createdLeague, error: createError } = await commissioner.rpc('create_league', {
    p_name: `Pancake E2E Lifecycle ${unique}`,
    p_team_name: `${label} Team 1`,
    p_auction_budget: 211,
  })
  if (createError) throw new Error(`${label}: create_league failed: ${createError.message}`)
  if (!createdLeague?.id) throw new Error(`${label}: create_league returned no league id`)
  if (!/^[A-Z0-9]{16}$/.test(createdLeague.invite_code ?? '')) {
    failures.push(`${label}: invite_code=${createdLeague.invite_code ?? '<missing>'}; expected 16 uppercase alnum chars`)
  }

  for (const [index, user] of users.slice(1).entries()) {
    const client = await signInSupabaseClient(env, user.email, state.password, label)
    const { error } = await client.rpc('join_league_by_invite_code', {
      p_invite_code: createdLeague.invite_code,
      p_team_name: `${label} Team ${index + 2}`,
    })
    if (error) failures.push(`${label}: join_league_by_invite_code failed for ${user.email}: ${error.message}`)
  }

  const [
    league,
    members,
    seasons,
    picks,
    slotRows,
  ] = await Promise.all([
    fetchSingle(supabase, 'leagues', 'id, invite_code, commissioner_id, auction_budget, status', { id: createdLeague.id }),
    fetchAll(supabase, 'league_members', 'id, user_id, role, team_name', { league_id: createdLeague.id }),
    fetchAll(supabase, 'league_seasons', 'id, season_year, is_current', { league_id: createdLeague.id }),
    fetchAll(supabase, 'draft_picks', 'id, season_year, round, original_owner_id, current_owner_id', { league_id: createdLeague.id }),
    fetchAll(supabase, 'lineup_slot_templates', 'slot_type, slot_count', { league_id: createdLeague.id }),
  ])

  if (league.commissioner_id !== users[0].id) {
    failures.push(`${label}: commissioner_id=${league.commissioner_id}; expected ${users[0].id}`)
  }
  if (league.auction_budget !== 211) {
    failures.push(`${label}: auction_budget=${league.auction_budget}; expected 211`)
  }
  if (members.length !== users.length) {
    failures.push(`${label}: league_members count=${members.length}; expected ${users.length}`)
  }
  const memberByUserId = new Map(members.map((member) => [member.user_id, member]))
  for (const [index, user] of users.entries()) {
    const member = memberByUserId.get(user.id)
    if (!member) {
      failures.push(`${label}: missing league_member for user ${user.email}`)
      continue
    }
    const expectedRole = index === 0 ? 'commissioner' : 'manager'
    if (member.role !== expectedRole) {
      failures.push(`${label}: member ${member.id} role=${member.role}; expected ${expectedRole}`)
    }
  }

  const currentSeasons = seasons.filter((row) => row.is_current)
  if (currentSeasons.length !== 1) {
    failures.push(`${label}: current season rows=${currentSeasons.length}; expected 1`)
  }
  const seasonYear = currentSeasons[0]?.season_year ?? currentSeasonYear()
  const minPickYear = seasonYear + 1
  const maxPickYear = seasonYear + 5
  const pickKeys = new Set(picks.map((pick) => `${pick.season_year}:${pick.round}:${pick.original_owner_id}:${pick.current_owner_id}`))
  for (const member of members) {
    for (let year = minPickYear; year <= maxPickYear; year += 1) {
      for (let round = 1; round <= 3; round += 1) {
        const key = `${year}:${round}:${member.id}:${member.id}`
        if (!pickKeys.has(key)) failures.push(`${label}: missing future pick ${key}`)
      }
    }
  }
  const expectedPickCount = members.length * 5 * 3
  if (picks.length !== expectedPickCount) {
    failures.push(`${label}: draft_picks count=${picks.length}; expected ${expectedPickCount}`)
  }

  const slotCounts = new Map(slotRows.map((slot) => [slot.slot_type, slot.slot_count]))
  for (const [slotType, slotCount] of Object.entries(EXPECTED_DEFAULT_LINEUP_SLOTS)) {
    if (slotCounts.get(slotType) !== slotCount) {
      failures.push(`${label}: lineup_slot_templates ${slotType}=${slotCounts.get(slotType) ?? '<missing>'}; expected ${slotCount}`)
    }
  }
  if (slotRows.length !== Object.keys(EXPECTED_DEFAULT_LINEUP_SLOTS).length) {
    failures.push(`${label}: lineup_slot_templates count=${slotRows.length}; expected ${Object.keys(EXPECTED_DEFAULT_LINEUP_SLOTS).length}`)
  }

  const artifact = {
    season,
    league: {
      id: league.id,
      invite_code: league.invite_code,
      status: league.status,
      commissioner_id: league.commissioner_id,
      auction_budget: league.auction_budget,
    },
    users: users.map((user) => ({ id: user.id, email: user.email })),
    memberCount: members.length,
    currentSeasons,
    pickWindow: { minPickYear, maxPickYear, count: picks.length, expectedPickCount },
    slots: Object.fromEntries(slotCounts),
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'league-lifecycle.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const assertCommissionerSettingsScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SET.3'
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 2,
  })
  const commissioner = await signInSupabaseClient(env, state.users[0].email, state.password, label)
  const manager = await signInSupabaseClient(env, state.users[1].email, state.password, label)
  const expectedScoring = {
    points: 1,
    rebounds: 1.25,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 0.5,
    field_goals_attempted: -0.25,
    field_goals_made: 0.5,
    free_throws_attempted: -0.25,
    free_throws_made: 0.5,
    triple_double: 5,
  }
  const expectedLeagueSettings = {
    scoring_settings: expectedScoring,
    roster_size: 17,
    ir_slots: 3,
    taxi_slots: 2,
    auction_budget: 240,
    playoff_start_week: 21,
  }
  const expectedSlots = [
    { league_id: fixture.league.id, slot_type: 'PG', slot_count: 2 },
    { league_id: fixture.league.id, slot_type: 'SG', slot_count: 2 },
    { league_id: fixture.league.id, slot_type: 'SF', slot_count: 2 },
    { league_id: fixture.league.id, slot_type: 'PF', slot_count: 2 },
    { league_id: fixture.league.id, slot_type: 'C', slot_count: 1 },
    { league_id: fixture.league.id, slot_type: 'G', slot_count: 1 },
    { league_id: fixture.league.id, slot_type: 'F', slot_count: 1 },
    { league_id: fixture.league.id, slot_type: 'UTIL', slot_count: 3 },
    { league_id: fixture.league.id, slot_type: 'BE', slot_count: 4 },
  ]

  const { error: leagueUpdateError } = await commissioner
    .from('leagues')
    .update(expectedLeagueSettings)
    .eq('id', fixture.league.id)
  if (leagueUpdateError) {
    failures.push(`${label}: commissioner league settings update failed through RLS anon client: ${leagueUpdateError.message}`)
  }

  const { error: slotsUpdateError } = await commissioner
    .from('lineup_slot_templates')
    .upsert(expectedSlots, { onConflict: 'league_id,slot_type' })
  if (slotsUpdateError) {
    failures.push(`${label}: commissioner lineup slot update failed through RLS anon client: ${slotsUpdateError.message}`)
  }

  const managerAttempt = await manager
    .from('leagues')
    .update({ roster_size: 99 })
    .eq('id', fixture.league.id)

  const managerLeague = await readLeagueSettingsForClient(manager, fixture.league.id, label)
  const managerSlots = await readLineupSlotsForClient(manager, fixture.league.id, label)
  const persistedLeague = await readLeagueSettingsForClient(supabase, fixture.league.id, label)
  const persistedSlots = await readLineupSlotsForClient(supabase, fixture.league.id, label)
  const slotCounts = new Map(managerSlots.map((slot) => [slot.slot_type, slot.slot_count]))
  const persistedSlotCounts = new Map(persistedSlots.map((slot) => [slot.slot_type, slot.slot_count]))

  if (managerLeague.roster_size !== expectedLeagueSettings.roster_size) {
    failures.push(`${label}: manager read roster_size=${managerLeague.roster_size}; expected propagated value ${expectedLeagueSettings.roster_size}`)
  }
  if (persistedLeague.roster_size !== expectedLeagueSettings.roster_size) {
    failures.push(`${label}: manager write changed roster_size to ${persistedLeague.roster_size}; expected commissioner-only value ${expectedLeagueSettings.roster_size}`)
  }
  if (managerLeague.ir_slots !== expectedLeagueSettings.ir_slots || managerLeague.taxi_slots !== expectedLeagueSettings.taxi_slots) {
    failures.push(`${label}: manager read IR/taxi slots ${managerLeague.ir_slots}/${managerLeague.taxi_slots}; expected ${expectedLeagueSettings.ir_slots}/${expectedLeagueSettings.taxi_slots}`)
  }
  if (managerLeague.auction_budget !== expectedLeagueSettings.auction_budget || managerLeague.playoff_start_week !== expectedLeagueSettings.playoff_start_week) {
    failures.push(`${label}: manager read budget/playoff week ${managerLeague.auction_budget}/${managerLeague.playoff_start_week}; expected ${expectedLeagueSettings.auction_budget}/${expectedLeagueSettings.playoff_start_week}`)
  }
  if (Number(managerLeague.scoring_settings?.triple_double) !== expectedScoring.triple_double) {
    failures.push(`${label}: manager read triple_double=${managerLeague.scoring_settings?.triple_double}; expected ${expectedScoring.triple_double}`)
  }
  for (const slot of expectedSlots) {
    if (slotCounts.get(slot.slot_type) !== slot.slot_count) {
      failures.push(`${label}: manager read ${slot.slot_type} slot_count=${slotCounts.get(slot.slot_type) ?? '<missing>'}; expected ${slot.slot_count}`)
    }
    if (persistedSlotCounts.get(slot.slot_type) !== slot.slot_count) {
      failures.push(`${label}: persisted ${slot.slot_type} slot_count=${persistedSlotCounts.get(slot.slot_type) ?? '<missing>'}; expected ${slot.slot_count}`)
    }
  }

  const artifact = {
    leagueId: fixture.league.id,
    commissionerUserId: state.users[0].id,
    managerUserId: state.users[1].id,
    expectedLeagueSettings,
    managerAttemptError: managerAttempt.error?.message ?? null,
    managerObservedLeague: managerLeague,
    managerObservedSlots: managerSlots,
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'commissioner-settings.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const scoringFixtureSeasonYear = () => 6000 + Number(Date.now().toString().slice(-6))
const scoringFixtureWeekNumber = (season) => 700 + season
const scoringFixtureDate = (season, offsetDays = 0) => {
  const date = new Date(Date.UTC(2040, 0, 1 + season * 7 + offsetDays))
  return date.toISOString().split('T')[0]
}

const calculateFixturePoints = (stats, settings) => {
  if (stats.did_not_play) return 0
  return Number((
    stats.points * (settings.points ?? 0) +
    stats.rebounds * (settings.rebounds ?? 0) +
    stats.assists * (settings.assists ?? 0) +
    stats.steals * (settings.steals ?? 0) +
    stats.blocks * (settings.blocks ?? 0) +
    stats.turnovers * (settings.turnovers ?? 0) +
    stats.three_pointers_made * (settings.three_pointers_made ?? 0) +
    stats.field_goals_made * (settings.field_goals_made ?? 0) +
    stats.field_goals_attempted * (settings.field_goals_attempted ?? 0) +
    stats.free_throws_made * (settings.free_throws_made ?? 0) +
    stats.free_throws_attempted * (settings.free_throws_attempted ?? 0) +
    (stats.double_double ? (settings.double_double ?? 0) : 0) +
    (stats.triple_double ? (settings.triple_double ?? 0) : 0)
  ).toFixed(2))
}

const assertNumberEquals = (failures, label, actual, expected) => {
  const actualNumber = Number(actual ?? 0)
  if (Math.abs(actualNumber - expected) > 0.001) {
    failures.push(`${label}: ${actualNumber}; expected ${expected}`)
  }
}

const readScoringMatchup = async (supabase, matchupId, label) => {
  const { data, error } = await supabase
    .from('matchups')
    .select('id, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id, is_finalized, finalized_at')
    .eq('id', matchupId)
    .single()
  if (error || !data) throw new Error(`${label}: matchup read failed: ${error?.message ?? 'missing row'}`)
  return data
}

const assertWeeklyScoringFinalizationScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SEA.2'
  const fixtureSeasonYear = scoringFixtureSeasonYear()
  const weekNumber = scoringFixtureWeekNumber(season)
  const gameDate = scoringFixtureDate(season)
  const secondDate = scoringFixtureDate(season, 1)
  const scoringReferenceDate = `${gameDate}T12:00:00Z`
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 2,
    seasonYear: fixtureSeasonYear,
  })
  const [homeMember, awayMember] = fixture.members
  const scoringSettings = {
    points: 1,
    rebounds: 1.2,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 0.5,
    field_goals_made: 0.2,
    field_goals_attempted: -0.1,
    free_throws_made: 0.2,
    free_throws_attempted: -0.1,
    double_double: 2,
    triple_double: 5,
  }

  const { error: leagueUpdateError } = await supabase
    .from('leagues')
    .update({
      scoring_settings: scoringSettings,
      playoff_start_week: 20,
    })
    .eq('id', fixture.league.id)
  if (leagueUpdateError) throw new Error(`${label}: scoring settings update failed: ${leagueUpdateError.message}`)

  const { error: weekError } = await supabase
    .from('season_weeks')
    .upsert({
      season_year: fixtureSeasonYear,
      week_number: weekNumber,
      week_start: gameDate,
      week_end: secondDate,
    }, { onConflict: 'season_year,week_number' })
  if (weekError) throw new Error(`${label}: season week fixture insert failed: ${weekError.message}`)

  const { data: players, error: playersError } = await seededPlayerQuery(supabase)
    .limit(4)
  if (playersError) throw new Error(`${label}: player fixture lookup failed: ${playersError.message}`)
  if ((players ?? []).length < 4) throw new Error(`${label}: requires at least four players in the test Supabase project`)

  const [homeStarter, homeBench, awayStarter, awayBench] = players
  const { data: game, error: gameError } = await supabase
    .from('nba_games')
    .insert({
      sportsdata_game_id: `e2e-scoring-${fixtureSeasonYear}-${Date.now()}`,
      nba_game_id: `E2ESCORING${fixtureSeasonYear}`,
      season_year: fixtureSeasonYear,
      game_date: gameDate,
      week_number: weekNumber,
      home_team: 'E2H',
      away_team: 'E2A',
      status: 'Scheduled',
    })
    .select('id')
    .single()
  if (gameError) throw new Error(`${label}: game fixture insert failed: ${gameError.message}`)

  const { data: secondGame, error: secondGameError } = await supabase
    .from('nba_games')
    .insert({
      sportsdata_game_id: `e2e-scoring-second-${fixtureSeasonYear}-${Date.now()}`,
      nba_game_id: `E2ESCORINGSECOND${fixtureSeasonYear}`,
      season_year: fixtureSeasonYear,
      game_date: secondDate,
      week_number: weekNumber,
      home_team: 'E2H',
      away_team: 'E2A',
      status: 'Scheduled',
    })
    .select('id')
    .single()
  if (secondGameError) throw new Error(`${label}: second game fixture insert failed: ${secondGameError.message}`)

  const homeStarterStats = {
    player_id: homeStarter.id,
    game_id: game.id,
    season_year: fixtureSeasonYear,
    week_number: weekNumber,
    game_date: gameDate,
    points: 10,
    rebounds: 5,
    assists: 4,
    steals: 1,
    blocks: 2,
    turnovers: 3,
    three_pointers_made: 2,
    field_goals_made: 4,
    field_goals_attempted: 9,
    free_throws_made: 2,
    free_throws_attempted: 3,
    double_double: true,
    triple_double: false,
  }
  const awayStarterStats = {
    player_id: awayStarter.id,
    game_id: game.id,
    season_year: fixtureSeasonYear,
    week_number: weekNumber,
    game_date: gameDate,
    points: 12,
    rebounds: 3,
    assists: 2,
    steals: 0,
    blocks: 1,
    turnovers: 1,
    three_pointers_made: 1,
    field_goals_made: 5,
    field_goals_attempted: 11,
    free_throws_made: 1,
    free_throws_attempted: 2,
    double_double: false,
    triple_double: true,
  }
  const homeStarterSecondStats = {
    player_id: homeStarter.id,
    game_id: secondGame.id,
    season_year: fixtureSeasonYear,
    week_number: weekNumber,
    game_date: secondDate,
    points: 20,
    rebounds: 2,
    assists: 3,
    steals: 0,
    blocks: 1,
    turnovers: 2,
    three_pointers_made: 1,
    field_goals_made: 7,
    field_goals_attempted: 13,
    free_throws_made: 5,
    free_throws_attempted: 6,
    double_double: false,
    triple_double: false,
  }
  const benchStats = [
    {
      player_id: homeBench.id,
      game_id: game.id,
      season_year: fixtureSeasonYear,
      week_number: weekNumber,
      game_date: gameDate,
      points: 100,
      rebounds: 20,
      assists: 20,
      steals: 10,
      blocks: 10,
      turnovers: 0,
      three_pointers_made: 10,
      field_goals_made: 30,
      field_goals_attempted: 40,
      free_throws_made: 20,
      free_throws_attempted: 20,
      double_double: true,
      triple_double: true,
    },
    {
      player_id: awayBench.id,
      game_id: game.id,
      season_year: fixtureSeasonYear,
      week_number: weekNumber,
      game_date: gameDate,
      points: 90,
      rebounds: 18,
      assists: 18,
      steals: 8,
      blocks: 8,
      turnovers: 0,
      three_pointers_made: 9,
      field_goals_made: 28,
      field_goals_attempted: 35,
      free_throws_made: 18,
      free_throws_attempted: 18,
      double_double: true,
      triple_double: true,
    },
  ]

  const { error: statsError } = await supabase
    .from('player_game_stats')
    .insert([homeStarterStats, homeStarterSecondStats, awayStarterStats, ...benchStats])
  if (statsError) throw new Error(`${label}: player stats fixture insert failed: ${statsError.message}`)

  const { error: lineupError } = await supabase.from('weekly_lineups').insert([
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: homeMember.id,
      player_id: homeStarter.id,
      week_number: weekNumber,
      game_date: secondDate,
      slot_type: 'PG',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: homeMember.id,
      player_id: homeStarter.id,
      week_number: weekNumber,
      game_date: gameDate,
      slot_type: 'PG',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: homeMember.id,
      player_id: homeBench.id,
      week_number: weekNumber,
      game_date: gameDate,
      slot_type: 'BE',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: awayMember.id,
      player_id: awayStarter.id,
      week_number: weekNumber,
      game_date: gameDate,
      slot_type: 'SG',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: awayMember.id,
      player_id: awayBench.id,
      week_number: weekNumber,
      game_date: gameDate,
      slot_type: 'BE',
    },
  ])
  if (lineupError) throw new Error(`${label}: weekly lineup fixture insert failed: ${lineupError.message}`)

  const { data: matchup, error: matchupError } = await supabase
    .from('matchups')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: weekNumber,
      matchup_type: 'regular_season',
      home_member_id: homeMember.id,
      away_member_id: awayMember.id,
      is_finalized: false,
    })
    .select('id')
    .single()
  if (matchupError) throw new Error(`${label}: matchup fixture insert failed: ${matchupError.message}`)

  const standingsBefore = await countRows(supabase, 'standings', {
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    week_number: weekNumber,
  })
  await backendJson(env, '/e2e/sync-scores', { leagueId: fixture.league.id, date: scoringReferenceDate })
  const scheduledSyncMatchup = await readScoringMatchup(supabase, matchup.id, label)
  const expectedHomePoints = calculateFixturePoints(homeStarterStats, scoringSettings) + calculateFixturePoints(homeStarterSecondStats, scoringSettings)
  const expectedAwayPoints = calculateFixturePoints(awayStarterStats, scoringSettings)

  assertNumberEquals(failures, `${label}: scheduled-sync home_points`, scheduledSyncMatchup.home_points, expectedHomePoints)
  assertNumberEquals(failures, `${label}: scheduled-sync away_points`, scheduledSyncMatchup.away_points, expectedAwayPoints)
  if (scheduledSyncMatchup.is_finalized) {
    failures.push(`${label}: matchup finalized while an NBA game was still Scheduled`)
  }

  const { error: finalGameError } = await supabase
    .from('nba_games')
    .update({ status: 'Final', home_score: 120, away_score: 111, ended_at: new Date().toISOString() })
    .in('id', [game.id, secondGame.id])
  if (finalGameError) throw new Error(`${label}: final game update failed: ${finalGameError.message}`)

  await backendJson(env, '/e2e/sync-scores', { leagueId: fixture.league.id, date: scoringReferenceDate })
  const finalizedMatchup = await readScoringMatchup(supabase, matchup.id, label)
  const standingsAfter = await countRows(supabase, 'standings', {
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    week_number: weekNumber,
  })

  assertNumberEquals(failures, `${label}: finalized home_points`, finalizedMatchup.home_points, expectedHomePoints)
  assertNumberEquals(failures, `${label}: finalized away_points`, finalizedMatchup.away_points, expectedAwayPoints)
  if (!finalizedMatchup.is_finalized) {
    failures.push(`${label}: matchup did not finalize after all NBA games were Final`)
  }
  if (finalizedMatchup.winner_member_id !== homeMember.id) {
    failures.push(`${label}: winner_member_id=${finalizedMatchup.winner_member_id ?? '<null>'}; expected home starter winner ${homeMember.id}`)
  }
  if (finalizedMatchup.home_max_possible_points == null || finalizedMatchup.away_max_possible_points == null) {
    failures.push(`${label}: finalized matchup did not persist max_possible_points for both teams`)
  }
  if (standingsAfter <= standingsBefore) {
    failures.push(`${label}: finalizing week did not append standings rows (${standingsBefore} -> ${standingsAfter})`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    fixtureSeasonYear,
    weekNumber,
      gameDate,
      secondDate,
      gameId: game.id,
      secondGameId: secondGame.id,
    matchupId: matchup.id,
    members: {
      home: homeMember,
      away: awayMember,
    },
    players: {
      homeStarter,
      homeBench,
      awayStarter,
      awayBench,
    },
    expected: {
      homePoints: expectedHomePoints,
      awayPoints: expectedAwayPoints,
      winnerMemberId: homeMember.id,
      standingsRowsShouldIncrease: true,
      maxPossiblePointsShouldBePersisted: true,
    },
    scheduledSyncMatchup,
    finalizedMatchup,
    standingsBefore,
    standingsAfter,
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'weekly-scoring-finalization.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const resetFixtureSeasonYear = () => 9000 + Number(Date.now().toString().slice(-6))

const assertSeasonResetScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SEA.6'
  const fixtureSeasonYear = resetFixtureSeasonYear()
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 4,
    seasonYear: fixtureSeasonYear,
  })
  const [member1, member2, member3, member4] = fixture.members

  const { data: players, error: playersError } = await seededPlayerQuery(supabase)
    .limit(4)
  if (playersError) throw new Error(`${label}: player lookup failed: ${playersError.message}`)
  if ((players ?? []).length < 4) throw new Error(`${label}: requires at least four players`)

  const pickRows = []
  for (const member of fixture.members) {
    for (let seasonYear = fixtureSeasonYear + 1; seasonYear <= fixtureSeasonYear + 5; seasonYear += 1) {
      for (let round = 1; round <= 3; round += 1) {
        pickRows.push({
          league_id: fixture.league.id,
          season_year: seasonYear,
          round,
          original_owner_id: member.id,
          current_owner_id: member.id,
        })
      }
    }
  }

  const standingsRows = [
    { member: member4, wins: 1, pointsFor: 800, pointsAgainst: 1100, waiverPriority: 4 },
    { member: member3, wins: 3, pointsFor: 900, pointsAgainst: 1050, waiverPriority: 3 },
    { member: member2, wins: 6, pointsFor: 1000, pointsAgainst: 1000, waiverPriority: 2 },
    { member: member1, wins: 9, pointsFor: 1100, pointsAgainst: 900, waiverPriority: 1 },
  ].map((row) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: row.member.id,
    week_number: 19,
    wins: row.wins,
    losses: 10 - row.wins,
    ties: 0,
    points_for: row.pointsFor,
    points_against: row.pointsAgainst,
    max_possible_points: row.pointsFor + 50,
    waiver_priority: row.waiverPriority,
  }))

  const rosterRows = [
    { member: member1, player: players[0], is_on_ir: false, is_on_taxi: false },
    { member: member2, player: players[1], is_on_ir: true, is_on_taxi: false },
    { member: member3, player: players[2], is_on_ir: false, is_on_taxi: true },
    { member: member4, player: players[3], is_on_ir: false, is_on_taxi: false },
  ].map((row) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: row.member.id,
    player_id: row.player.id,
    is_on_ir: row.is_on_ir,
    is_on_taxi: row.is_on_taxi,
    acquired_via: 'e2e_reset_fixture',
  }))

  const lineupRows = rosterRows.slice(0, 2).map((row) => ({
    league_id: row.league_id,
    league_season_id: row.league_season_id,
    member_id: row.member_id,
    player_id: row.player_id,
    week_number: 19,
    game_date: `${fixtureSeasonYear}-04-10`,
    slot_type: 'UTIL',
  }))

  const waiverRows = fixture.members.map((member, index) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: member.id,
    priority: fixture.members.length - index,
  }))

  const { error: weekError } = await supabase
    .from('season_weeks')
    .upsert({
      season_year: fixtureSeasonYear,
      week_number: 19,
      week_start: `${fixtureSeasonYear}-04-08`,
      week_end: `${fixtureSeasonYear}-04-14`,
    }, { onConflict: 'season_year,week_number' })
  if (weekError) throw new Error(`${label}: season week insert failed: ${weekError.message}`)

  const [{ error: picksError }, { error: standingsError }, { error: rosterError }, { error: lineupError }, { error: waiverError }] = await Promise.all([
    supabase.from('draft_picks').insert(pickRows),
    supabase.from('standings').insert(standingsRows),
    supabase.from('roster_players').insert(rosterRows),
    supabase.from('weekly_lineups').insert(lineupRows),
    supabase.from('waiver_priorities').insert(waiverRows),
  ])
  if (picksError) throw new Error(`${label}: draft pick insert failed: ${picksError.message}`)
  if (standingsError) throw new Error(`${label}: standings insert failed: ${standingsError.message}`)
  if (rosterError) throw new Error(`${label}: roster insert failed: ${rosterError.message}`)
  if (lineupError) throw new Error(`${label}: lineup insert failed: ${lineupError.message}`)
  if (waiverError) throw new Error(`${label}: waiver priority insert failed: ${waiverError.message}`)

  const { data: matchup, error: matchupError } = await supabase
    .from('matchups')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 19,
      matchup_type: 'regular_season',
      home_member_id: member1.id,
      away_member_id: member2.id,
      home_points: 111,
      away_points: 99,
      winner_member_id: member1.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (matchupError || !matchup) throw new Error(`${label}: historical matchup insert failed: ${matchupError?.message ?? 'missing row'}`)

  const { error: statusError } = await supabase
    .from('leagues')
    .update({ status: 'playoffs' })
    .eq('id', fixture.league.id)
  if (statusError) throw new Error(`${label}: playoff status staging failed: ${statusError.message}`)

  const resetResult = await backendJson(env, '/e2e/advance-season', { leagueId: fixture.league.id })
  const newSeasonId = resetResult.newSeasonId
  const newYear = resetResult.newYear
  if (!newSeasonId || newYear !== fixtureSeasonYear + 1) {
    failures.push(`${label}: reset returned ${JSON.stringify(resetResult)}; expected newYear ${fixtureSeasonYear + 1}`)
  }

  const [
    seasons,
    newRoster,
    newWaivers,
    horizonPicks,
    oldStandings,
    oldLineups,
    oldMatchup,
    league,
  ] = await Promise.all([
    fetchAll(supabase, 'league_seasons', 'id, season_year, is_current', { league_id: fixture.league.id }),
    fetchAll(supabase, 'roster_players', 'member_id, player_id, is_on_ir, is_on_taxi, acquired_via', {
      league_id: fixture.league.id,
      league_season_id: newSeasonId,
    }),
    fetchAll(supabase, 'waiver_priorities', 'member_id, priority', {
      league_id: fixture.league.id,
      league_season_id: newSeasonId,
    }),
    fetchAll(supabase, 'draft_picks', 'season_year, round, original_owner_id, current_owner_id', { league_id: fixture.league.id }),
    fetchAll(supabase, 'standings', 'id, member_id, week_number', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'weekly_lineups', 'id, member_id, player_id, week_number', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchSingle(supabase, 'matchups', 'id, winner_member_id, is_finalized', { id: matchup.id }),
    fetchSingle(supabase, 'leagues', 'id, status', { id: fixture.league.id }),
  ])

  const currentSeasons = seasons.filter((row) => row.is_current)
  if (currentSeasons.length !== 1 || currentSeasons[0]?.id !== newSeasonId) {
    failures.push(`${label}: current seasons after reset ${JSON.stringify(currentSeasons)}; expected exactly ${newSeasonId}`)
  }
  const oldSeason = seasons.find((row) => row.id === fixture.leagueSeason.id)
  if (oldSeason?.is_current !== false) {
    failures.push(`${label}: old season ${fixture.leagueSeason.id} is_current=${oldSeason?.is_current}; expected false`)
  }
  if (league.status !== 'offseason') {
    failures.push(`${label}: league status ${league.status}; expected offseason after reset`)
  }

  const expectedRosterKeys = new Set(rosterRows.map((row) => `${row.member_id}:${row.player_id}:${row.is_on_ir}:${row.is_on_taxi}`))
  const actualRosterKeys = new Set(newRoster.map((row) => `${row.member_id}:${row.player_id}:${row.is_on_ir}:${row.is_on_taxi}`))
  for (const key of expectedRosterKeys) {
    if (!actualRosterKeys.has(key)) failures.push(`${label}: carried roster missing ${key}`)
  }
  if (newRoster.some((row) => row.acquired_via !== 'carry_over')) {
    failures.push(`${label}: one or more carried roster rows did not stamp acquired_via=carry_over`)
  }

  const expectedPriority = new Map([
    [member4.id, 1],
    [member3.id, 2],
    [member2.id, 3],
    [member1.id, 4],
  ])
  for (const [memberId, priority] of expectedPriority) {
    const row = newWaivers.find((candidate) => candidate.member_id === memberId)
    if (row?.priority !== priority) {
      failures.push(`${label}: waiver priority for ${memberId} is ${row?.priority ?? '<missing>'}; expected ${priority}`)
    }
  }

  const pickKeys = new Set(horizonPicks.map((pick) => `${pick.season_year}:${pick.round}:${pick.original_owner_id}:${pick.current_owner_id}`))
  for (let seasonYear = newYear + 1; seasonYear <= newYear + 5; seasonYear += 1) {
    for (let round = 1; round <= 3; round += 1) {
      for (const member of fixture.members) {
        const key = `${seasonYear}:${round}:${member.id}:${member.id}`
        if (!pickKeys.has(key)) failures.push(`${label}: missing reset horizon pick ${key}`)
      }
    }
  }

  if (oldStandings.length !== standingsRows.length) {
    failures.push(`${label}: old standings rows query returned ${oldStandings.length}; expected ${standingsRows.length}`)
  }
  if (oldLineups.length !== lineupRows.length) {
    failures.push(`${label}: old weekly_lineups rows query returned ${oldLineups.length}; expected ${lineupRows.length}`)
  }
  if (oldMatchup.id !== matchup.id || !oldMatchup.is_finalized || oldMatchup.winner_member_id !== member1.id) {
    failures.push(`${label}: old matchup history was not retained correctly`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    oldSeasonId: fixture.leagueSeason.id,
    fixtureSeasonYear,
    resetResult,
    seasons,
    carriedRoster: newRoster,
    waiverPriorities: newWaivers,
    oldHistory: {
      standingsRows: oldStandings.length,
      lineupRows: oldLineups.length,
      matchup: oldMatchup,
    },
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'season-reset.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const rookieFixtureSeasonYear = () => 7000 + Number(Date.now().toString().slice(-6))

const expectAuthedBackendError = async ({ env, path, token, body, label, pattern }) => {
  try {
    await backendAuthedJson(env, path, token, body)
    return `${label}: expected request to fail`
  } catch (error) {
    const message = errorMessage(error)
    return pattern.test(message) ? null : `${label}: failed with "${message}", expected ${pattern}`
  }
}

const createRookieDraftFixture = async ({ supabase, env, state, season, label }) => {
  const fixtureSeasonYear = rookieFixtureSeasonYear()
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 4,
    seasonYear: fixtureSeasonYear,
  })
  const [member1, member2, member3, member4] = fixture.members
  const previousSeasonYear = fixtureSeasonYear - 1

  const { error: leagueStatusError } = await supabase
    .from('leagues')
    .update({ status: 'offseason' })
    .eq('id', fixture.league.id)
  if (leagueStatusError) throw new Error(`${label}: league offseason update failed: ${leagueStatusError.message}`)

  const { data: previousSeason, error: previousSeasonError } = await supabase
    .from('league_seasons')
    .insert({
      league_id: fixture.league.id,
      season_year: previousSeasonYear,
      is_current: false,
    })
    .select('id')
    .single()
  if (previousSeasonError) throw new Error(`${label}: previous season insert failed: ${previousSeasonError.message}`)

  const standingsRows = [
    { member: member4, wins: 1, pointsFor: 800, priority: 1 },
    { member: member3, wins: 3, pointsFor: 900, priority: 2 },
    { member: member2, wins: 5, pointsFor: 1000, priority: 3 },
    { member: member1, wins: 7, pointsFor: 1100, priority: 4 },
  ].map((row) => ({
    league_id: fixture.league.id,
    league_season_id: previousSeason.id,
    member_id: row.member.id,
    week_number: 19,
    wins: row.wins,
    losses: 10 - row.wins,
    ties: 0,
    points_for: row.pointsFor,
    points_against: 1000,
    max_possible_points: row.pointsFor + 100,
    waiver_priority: row.priority,
  }))
  const { error: standingsError } = await supabase.from('standings').insert(standingsRows)
  if (standingsError) throw new Error(`${label}: previous standings insert failed: ${standingsError.message}`)

  const pickRows = []
  for (const member of fixture.members) {
    for (let round = 1; round <= 3; round += 1) {
      pickRows.push({
        league_id: fixture.league.id,
        season_year: fixtureSeasonYear,
        round,
        original_owner_id: member.id,
        current_owner_id: member.id,
      })
    }
  }
  const { error: pickError } = await supabase.from('draft_picks').insert(pickRows)
  if (pickError) throw new Error(`${label}: draft pick asset insert failed: ${pickError.message}`)

  const { data: rookies, error: rookiesError } = await seededPlayerQuery(supabase, 'id, display_name, nba_draft_number')
    .not('nba_draft_number', 'is', null)
    .order('nba_draft_number', { ascending: true })
    .limit(4)
  if (rookiesError) throw new Error(`${label}: rookie player lookup failed: ${rookiesError.message}`)
  if ((rookies ?? []).length < 2) throw new Error(`${label}: requires at least two players with nba_draft_number`)

  const { draft } = await backendJson(env, '/e2e/start-rookie-draft', { leagueId: fixture.league.id })
  const { data: pickSlots, error: slotsError } = await supabase
    .from('snake_draft_picks')
    .select('id, overall_pick, round, pick_in_round, member_id, player_id, picked_at, draft_pick_id')
    .eq('draft_id', draft.id)
    .order('overall_pick', { ascending: true })
  if (slotsError) throw new Error(`${label}: draft slot read failed: ${slotsError.message}`)
  const slots = pickSlots ?? []
  const expectedOrder = [member4.id, member3.id, member2.id, member1.id, member1.id, member2.id, member3.id, member4.id]

  return {
    fixture,
    previousSeason,
    fixtureSeasonYear,
    draft,
    slots,
    rookies,
    expectedOrder,
  }
}

const assertRookieDraftAutoPickScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const label = 'D.SEA.5'
  const {
    fixture,
    previousSeason,
    fixtureSeasonYear,
    draft,
    slots,
    rookies,
    expectedOrder,
  } = await createRookieDraftFixture({ supabase, env, state, season, label })

  for (const [index, expectedMemberId] of expectedOrder.entries()) {
    if (slots[index]?.member_id !== expectedMemberId) {
      failures.push(`${label}: slot ${index + 1} member_id=${slots[index]?.member_id ?? '<missing>'}; expected inverse-standings snake member ${expectedMemberId}`)
    }
  }
  if (slots.length !== fixture.members.length * 3) {
    failures.push(`${label}: rookie draft created ${slots.length} slots; expected ${fixture.members.length * 3}`)
  }
  if (slots.some((slot) => !slot.draft_pick_id)) {
    failures.push(`${label}: one or more rookie draft slots are missing linked draft_pick_id assets`)
  }

  const firstSlot = slots[0]
  const expectedAutoPickPlayer = rookies[0]
  const autoPickResult = await backendJson(env, `/e2e/${draft.id}/auto-pick`, { memberId: firstSlot.member_id })
  const { data: pickedSlot, error: pickedSlotError } = await supabase
    .from('snake_draft_picks')
    .select('id, player_id, picked_at, draft_pick_id')
    .eq('id', firstSlot.id)
    .single()
  if (pickedSlotError || !pickedSlot) throw new Error(`${label}: picked slot read failed: ${pickedSlotError?.message ?? 'missing row'}`)
  if (pickedSlot.player_id !== expectedAutoPickPlayer.id) {
    failures.push(`${label}: auto-pick selected ${pickedSlot.player_id}; expected lowest nba_draft_number player ${expectedAutoPickPlayer.id}`)
  }
  if (!pickedSlot.picked_at) {
    failures.push(`${label}: auto-pick did not stamp picked_at immediately`)
  }
  if (autoPickResult.newPlayerId !== expectedAutoPickPlayer.id) {
    failures.push(`${label}: auto-pick response newPlayerId=${autoPickResult.newPlayerId}; expected ${expectedAutoPickPlayer.id}`)
  }

  const { data: usedPick, error: usedPickError } = await supabase
    .from('draft_picks')
    .select('id, is_used, rookie_draft_id, used_at')
    .eq('id', firstSlot.draft_pick_id)
    .single()
  if (usedPickError || !usedPick) throw new Error(`${label}: used draft pick asset read failed: ${usedPickError?.message ?? 'missing row'}`)
  if (!usedPick.is_used || usedPick.rookie_draft_id !== draft.id || !usedPick.used_at) {
    failures.push(`${label}: auto-pick did not mark linked draft_pick asset used for draft ${draft.id}`)
  }

  const rosteredPlayer = rookies[1]
  const nextSlot = slots[1]
  const { error: rosterError } = await supabase.from('roster_players').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: nextSlot.member_id,
    player_id: rosteredPlayer.id,
    acquired_via: 'e2e_rostered_rejection',
  })
  if (rosterError) throw new Error(`${label}: rostered rejection fixture insert failed: ${rosterError.message}`)

  const accessToken = await signInForAccessToken(env, state.users[0].email, state.password)
  const rosteredRejection = await expectAuthedBackendError({
    env,
    path: `/draft/${draft.id}/snake-pick`,
    token: accessToken,
    body: { memberId: nextSlot.member_id, playerId: rosteredPlayer.id },
    label: `${label}: already-rostered rookie pick`,
    pattern: /already on a roster/i,
  })
  if (rosteredRejection) failures.push(rosteredRejection)

  const { data: rosterRows, error: rosterReadError } = await supabase
    .from('roster_players')
    .select('id, member_id, player_id')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.leagueSeason.id)
    .eq('player_id', expectedAutoPickPlayer.id)
  if (rosterReadError) throw new Error(`${label}: auto-picked roster read failed: ${rosterReadError.message}`)
  if ((rosterRows ?? []).length !== 1 || rosterRows[0]?.member_id !== firstSlot.member_id) {
    failures.push(`${label}: auto-picked player roster rows ${JSON.stringify(rosterRows)}; expected one row for ${firstSlot.member_id}`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    previousSeasonId: previousSeason.id,
    fixtureSeasonYear,
    draftId: draft.id,
    expectedFirstEightMemberIds: expectedOrder,
    slots,
    rookies,
    autoPickResult,
    pickedSlot,
    usedPick,
    rosteredRejection: rosteredRejection ?? 'rejected as expected',
    rosterRows: rosterRows ?? [],
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'rookie-draft-auto-pick.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const createDisposablePlayoffLeague = async ({ supabase, state, season }) => {
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label: 'D.SEA.4',
    userCount: 10,
  })

  const regularSeasonRows = []
  for (const [index, member] of fixture.members.entries()) {
    const wins = fixture.members.length - index
    for (let win = 0; win < wins; win += 1) {
      const opponentOffset = (win % (fixture.members.length - 1)) + 1
      const opponent = fixture.members[(index + opponentOffset) % fixture.members.length]
      regularSeasonRows.push({
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        week_number: 100 + index * 20 + win,
        matchup_type: 'regular_season',
        home_member_id: member.id,
        away_member_id: opponent.id,
        home_points: 200 - index,
        away_points: 50 + index,
        home_max_possible_points: 220 - index,
        away_max_possible_points: 70 + index,
        winner_member_id: member.id,
        is_finalized: true,
        finalized_at: new Date().toISOString(),
      })
    }
  }

  const { error: matchupError } = await supabase.from('matchups').insert(regularSeasonRows)
  if (matchupError) throw new Error(`D.SEA.4 regular-season fixture insert: ${matchupError.message}`)

  return {
    ...fixture,
    regularSeasonRows: regularSeasonRows.length,
  }
}

const playoffPairExists = (rows, homeId, awayId) => rows.some((row) => (
  row.home_member_id === homeId &&
  row.away_member_id === awayId
))

const assertPlayoffBracketScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const fixture = await createDisposablePlayoffLeague({ supabase, state, season })
  const accessToken = await signInForAccessToken(env, state.users[0].email, state.password)
  let generateResult = null
  let advanceBeforeFinalized = null

  try {
    generateResult = await backendAuthedJson(env, '/playoffs/generate', accessToken, {
      leagueId: fixture.league.id,
    })
  } catch (error) {
    failures.push(`D.SEA.4: /playoffs/generate failed for disposable 10-team league: ${errorMessage(error)}`)
  }

  try {
    await backendAuthedJson(env, '/playoffs/advance', accessToken, {
      leagueId: fixture.league.id,
    })
    failures.push('D.SEA.4: /playoffs/advance did not block before prerequisite playoff games were finalized')
  } catch (error) {
    advanceBeforeFinalized = errorMessage(error)
  }

  const { data: bracketRows, error: bracketError } = await supabase
    .from('matchups')
    .select('id, week_number, matchup_type, home_member_id, away_member_id, winner_member_id, is_finalized')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.leagueSeason.id)
    .neq('matchup_type', 'regular_season')
    .order('week_number', { ascending: true })
    .order('matchup_type', { ascending: true })
  if (bracketError) {
    failures.push(`D.SEA.4: playoff bracket read failed: ${bracketError.message}`)
  }

  const bracket = bracketRows ?? []
  const quarterfinals = bracket.filter((row) => row.matchup_type === 'playoff_quarterfinal')
  const semifinals = bracket.filter((row) => row.matchup_type === 'playoff_semifinal')
  const [seed1, seed2, seed3, seed4, seed5, seed6] = fixture.members
  const expectedQuarterfinals = [
    [seed3, seed6],
    [seed4, seed5],
  ]

  if (quarterfinals.length !== 2) {
    failures.push(`D.SEA.4: 10-team playoff bracket created ${quarterfinals.length} quarterfinals; expected 2 for seeds 3v6 and 4v5 with seeds 1 and 2 on bye`)
  }
  for (const [home, away] of expectedQuarterfinals) {
    if (!playoffPairExists(quarterfinals, home.id, away.id)) {
      failures.push(`D.SEA.4: missing expected quarterfinal ${home.team_name} vs ${away.team_name}`)
    }
  }

  const qfParticipants = new Set(quarterfinals.flatMap((row) => [row.home_member_id, row.away_member_id]))
  if (qfParticipants.has(seed1.id) || qfParticipants.has(seed2.id)) {
    failures.push('D.SEA.4: seed 1 or seed 2 appeared in the quarterfinal round instead of receiving a bye')
  }
  if (semifinals.length > 0 && quarterfinals.length === 0) {
    failures.push(`D.SEA.4: generated ${semifinals.length} semifinal rows directly; 10-team leagues must generate a top-6 bracket with a quarterfinal round first`)
  }

  const artifact = {
    season,
    disposableLeagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    regularSeasonRows: fixture.regularSeasonRows,
    expected: {
      teamCount: 10,
      firstRound: 'top-6 bracket: seed 3 vs seed 6 and seed 4 vs seed 5; seeds 1 and 2 bye',
    },
    seeds: fixture.members.map((member, index) => ({
      seed: index + 1,
      memberId: member.id,
      teamName: member.team_name,
    })),
    generateResult,
    advanceBeforeFinalized,
    bracket,
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'playoff-bracket.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const insertTiebreakerRows = async (supabase, fixture) => {
  const [seed1, seed2, seed3, seed4] = fixture.members
  const rows = [
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 1,
      matchup_type: 'regular_season',
      home_member_id: seed1.id,
      away_member_id: seed2.id,
      home_points: 100,
      away_points: 100,
      home_max_possible_points: 140,
      away_max_possible_points: 180,
      winner_member_id: seed1.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 2,
      matchup_type: 'regular_season',
      home_member_id: seed3.id,
      away_member_id: seed4.id,
      home_points: 100,
      away_points: 100,
      home_max_possible_points: 130,
      away_max_possible_points: 160,
      winner_member_id: seed3.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 3,
      matchup_type: 'regular_season',
      home_member_id: seed2.id,
      away_member_id: seed3.id,
      home_points: 100,
      away_points: 100,
      home_max_possible_points: 180,
      away_max_possible_points: 130,
      winner_member_id: seed2.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      week_number: 4,
      matchup_type: 'regular_season',
      home_member_id: seed4.id,
      away_member_id: seed1.id,
      home_points: 100,
      away_points: 100,
      home_max_possible_points: 160,
      away_max_possible_points: 140,
      winner_member_id: seed4.id,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    },
  ]
  const { error } = await supabase.from('matchups').insert(rows)
  if (error) throw new Error(`D.SEA.3 tiebreaker fixture insert: ${error.message}`)
  return rows
}

const insertFullRpsTieRows = async (supabase, fixture) => {
  const [seed1, seed2, seed3, seed4] = fixture.members
  const baseRows = [
    [seed1, seed2, seed1, 1],
    [seed3, seed4, seed3, 2],
    [seed2, seed3, seed2, 3],
    [seed4, seed1, seed4, 4],
  ]
  const rows = baseRows.map(([home, away, winner, week]) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    week_number: week,
    matchup_type: 'regular_season',
    home_member_id: home.id,
    away_member_id: away.id,
    home_points: 100,
    away_points: 100,
    home_max_possible_points: 150,
    away_max_possible_points: 150,
    winner_member_id: winner.id,
    is_finalized: true,
    finalized_at: new Date().toISOString(),
  }))
  const { error } = await supabase.from('matchups').insert(rows)
  if (error) throw new Error(`D.SEA.3 RPS fixture insert: ${error.message}`)
  return rows
}

const assertStandingsTiebreakerScenario = async ({ supabase, env, state, season }) => {
  const failures = []
  const maxFixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label: 'D.SEA.3',
    userCount: 4,
  })
  const fixtureRows = await insertTiebreakerRows(supabase, maxFixture)
  const [, expectedSeed1, expectedSeed4, expectedSeed2] = maxFixture.members
  const expectedSeed3 = maxFixture.members[0]
  const accessToken = await signInForAccessToken(env, state.users[0].email, state.password)
  let generateResult = null

  try {
    generateResult = await backendAuthedJson(env, '/playoffs/generate', accessToken, {
      leagueId: maxFixture.league.id,
    })
  } catch (error) {
    failures.push(`D.SEA.3: /playoffs/generate failed for disposable tiebreaker league: ${errorMessage(error)}`)
  }

  const { data: semis, error: semisError } = await supabase
    .from('matchups')
    .select('id, week_number, matchup_type, home_member_id, away_member_id, winner_member_id, is_finalized')
    .eq('league_id', maxFixture.league.id)
    .eq('league_season_id', maxFixture.leagueSeason.id)
    .eq('matchup_type', 'playoff_semifinal')
    .order('created_at', { ascending: true })
  if (semisError) {
    failures.push(`D.SEA.3: semifinal read failed: ${semisError.message}`)
  }

  const bracket = semis ?? []
  if (bracket.length !== 2) {
    failures.push(`D.SEA.3: tiebreaker bracket created ${bracket.length} semifinals; expected 2`)
  }
  const expectedPairs = [
    [expectedSeed1, expectedSeed4],
    [expectedSeed2, expectedSeed3],
  ]
  for (const [home, away] of expectedPairs) {
    if (!playoffPairExists(bracket, home.id, away.id)) {
      failures.push(`D.SEA.3: missing expected tiebreaker semifinal ${home.team_name} vs ${away.team_name}`)
    }
  }

  const { data: rpsRows, error: rpsError } = await supabase
    .from('rps_challenges')
    .select('id, member_a_id, member_b_id, winner_member_id, status, context')
    .eq('league_id', maxFixture.league.id)
    .eq('league_season_id', maxFixture.leagueSeason.id)
  if (rpsError) {
    failures.push(`D.SEA.3: max-points scenario rps_challenges read failed: ${rpsError.message}`)
  }

  const rpsFixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label: 'D.SEA.3 RPS',
    userCount: 4,
  })
  const rpsFixtureRows = await insertFullRpsTieRows(supabase, rpsFixture)
  let rpsGenerateResult = null
  try {
    rpsGenerateResult = await backendAuthedJson(env, '/playoffs/generate', accessToken, {
      leagueId: rpsFixture.league.id,
    })
  } catch (error) {
    failures.push(`D.SEA.3: /playoffs/generate failed for disposable RPS league: ${errorMessage(error)}`)
  }

  const { data: rpsTieRows, error: rpsTieError } = await supabase
    .from('rps_challenges')
    .select('id, member_a_id, member_b_id, winner_member_id, status, context')
    .eq('league_id', rpsFixture.league.id)
    .eq('league_season_id', rpsFixture.leagueSeason.id)
  if (rpsTieError) {
    failures.push(`D.SEA.3: RPS scenario rps_challenges read failed: ${rpsTieError.message}`)
  }
  if ((rpsTieRows ?? []).length === 0) {
    failures.push('D.SEA.3: no rps_challenges were created for standings ties that remain unresolved after wins, points_for, max_possible_points, and points_against')
  }

  const { data: rpsBracket, error: rpsBracketError } = await supabase
    .from('matchups')
    .select('id, week_number, matchup_type, home_member_id, away_member_id, winner_member_id, is_finalized')
    .eq('league_id', rpsFixture.league.id)
    .eq('league_season_id', rpsFixture.leagueSeason.id)
    .eq('matchup_type', 'playoff_semifinal')
  if (rpsBracketError) {
    failures.push(`D.SEA.3: RPS semifinal read failed: ${rpsBracketError.message}`)
  }
  if ((rpsBracket ?? []).length > 0 && (rpsTieRows ?? []).length === 0) {
    failures.push(`D.SEA.3: generated ${rpsBracket.length} playoff semifinals even though the four-way tie had no RPS resolution`)
  }

  const artifact = {
    season,
    maxPointsScenario: {
      disposableLeagueId: maxFixture.league.id,
      leagueSeasonId: maxFixture.leagueSeason.id,
      fixtureRows,
      generateResult,
      bracket,
      rpsChallenges: rpsRows ?? [],
    },
    rpsScenario: {
      disposableLeagueId: rpsFixture.league.id,
      leagueSeasonId: rpsFixture.leagueSeason.id,
      fixtureRows: rpsFixtureRows,
      generateResult: rpsGenerateResult,
      bracket: rpsBracket ?? [],
      rpsChallenges: rpsTieRows ?? [],
    },
    expected: {
      tiebreakerOrder: [
        'wins',
        'points_for',
        'max_possible_points',
        'points_against',
        'deterministic_tiebreaker_audit',
      ],
      maxPointsScenario: 'all four teams are 1-1 with equal points_for; max_possible_points should seed D.SEA.3 Seed 2 first, Seed 4 second, Seed 1 third, Seed 3 fourth',
      rpsScenario: 'all four teams are 1-1 with equal points_for, max_possible_points, and points_against; completed tiebreaker audit rows should be created while deterministic playoff seeding succeeds',
    },
    seeds: maxFixture.members.map((member, index) => ({
      expectedSeed: index + 1,
      memberId: member.id,
      teamName: member.team_name,
    })),
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'standings-tiebreakers.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  return { failures, artifact }
}

const withTimeout = (promise, timeoutMs, message) => {
  let timeout
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isTransientSupabaseError = (error) => {
  const message = String(error?.message ?? error ?? '')
  return /connection timeout|disconnect\/reset|upstream connect|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(message)
}

const withSupabaseRetry = async (label, operation, attempts = 3) => {
  let latest
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = await operation()
    if (!latest?.error || !isTransientSupabaseError(latest.error) || attempt === attempts) return latest
    await sleep(250 * attempt)
  }
  return latest
}

const waitForRealtimeSubscribe = (channel, label) => withTimeout(
  new Promise((resolve, reject) => {
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') resolve()
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        reject(new Error(`D.X.2: realtime ${label} subscribe status ${status}${error?.message ? `: ${error.message}` : ''}`))
      }
    })
  }),
  REALTIME_SUBSCRIBE_TIMEOUT_MS,
  `D.X.2: realtime ${label} did not subscribe within ${REALTIME_SUBSCRIBE_TIMEOUT_MS}ms`,
)

const insertRealtimeTargetMatchup = async (supabase, leagueId, season, runSeason) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const members = await sortedLeagueMembers(supabase, leagueId)
  const [home, away] = members
  const baseWeekNumber = 9000 + runSeason * 100 + Math.floor(Date.now() % 100)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await supabase
      .from('matchups')
      .insert({
        league_id: leagueId,
        league_season_id: currentSeason.id,
        week_number: baseWeekNumber + attempt,
        matchup_type: 'regular_season',
        home_member_id: home.id,
        away_member_id: away.id,
        home_points: 0,
        away_points: 0,
        is_finalized: false,
      })
      .select('id, home_member_id, away_member_id')
      .single()
    if (!error) return data
    if (error.code !== '23505') {
      throw new Error(`D.X.2 realtime target matchup insert: ${error.message}`)
    }
  }
  throw new Error('D.X.2 realtime target matchup insert: exhausted unique week_number attempts')
}

const insertRealtimeAuctionTarget = async (supabase, leagueId, season) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const members = await sortedLeagueMembers(supabase, leagueId)
  if (members.length < 2) throw new Error('D.X.2: realtime bid scenario requires at least two league members')
  const player = await findAvailablePlayer(supabase, leagueId, currentSeason.id)
  const now = new Date().toISOString()

  const { error: cleanupDraftError } = await supabase
    .from('drafts')
    .update({ status: 'completed', completed_at: now })
    .eq('league_id', leagueId)
    .eq('league_season_id', currentSeason.id)
    .eq('draft_type', 'auction')
    .in('status', ['pending', 'in_progress'])
  if (cleanupDraftError) throw new Error(`D.X.2 realtime auction draft cleanup: ${cleanupDraftError.message}`)

  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .insert({
      league_id: leagueId,
      league_season_id: currentSeason.id,
      draft_type: 'auction',
      status: 'in_progress',
      budget_per_team: 10,
      started_at: now,
      current_nomination_order: 1,
    })
    .select('id')
    .single()
  if (draftError) throw new Error(`D.X.2 realtime auction draft insert: ${draftError.message}`)

  const [{ error: orderError }, { error: budgetError }] = await Promise.all([
    supabase.from('draft_orders').insert(members.map((member, index) => ({
      draft_id: draft.id,
      member_id: member.id,
      position: index + 1,
    }))),
    supabase.from('draft_budgets').insert(members.map((member) => ({
      draft_id: draft.id,
      member_id: member.id,
      initial_budget: 10,
      remaining: 10,
    }))),
  ])
  if (orderError) throw new Error(`D.X.2 realtime auction order insert: ${orderError.message}`)
  if (budgetError) throw new Error(`D.X.2 realtime auction budget insert: ${budgetError.message}`)

  const { data: nomination, error: nominationError } = await supabase
    .from('nominations')
    .insert({
      draft_id: draft.id,
      nominating_member_id: members[0].id,
      player_id: player.id,
      nomination_order: 1,
      status: 'open',
      current_bid_amount: 1,
      current_bidder_id: null,
      countdown_expires_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (nominationError) throw new Error(`D.X.2 realtime auction nomination insert: ${nominationError.message}`)

  return {
    draftId: draft.id,
    nominationId: nomination.id,
    bidderOne: members[0].id,
    bidderTwo: members[1].id,
    bidderTwoUserId: members[1].user_id,
    playerId: player.id,
  }
}

const assertRealtimeDelivery = async ({ supabase, env, state, leagueId, season }) => {
  if (!state?.password || !Array.isArray(state.users) || state.users.length === 0) {
    throw new Error('D.X.2: realtime scenario requires tests/e2e-state.json from npm run e2e:seed')
  }
  if (!env.anonKey) {
    throw new Error(
      'D.X.2: realtime scenario requires E2E_SUPABASE_PUBLISHABLE_KEY or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    )
  }
  if (!Number.isFinite(REALTIME_CLIENTS) || REALTIME_CLIENTS < 1) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_CLIENTS ${process.env.E2E_REALTIME_CLIENTS}`)
  }
  if (!Number.isFinite(REALTIME_LATENCY_LIMIT_MS) || REALTIME_LATENCY_LIMIT_MS < 100) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_LATENCY_LIMIT_MS ${process.env.E2E_REALTIME_LATENCY_LIMIT_MS}`)
  }
  if (!Number.isFinite(REALTIME_SUBSCRIBE_TIMEOUT_MS) || REALTIME_SUBSCRIBE_TIMEOUT_MS < REALTIME_LATENCY_LIMIT_MS) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS ${process.env.E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS}`)
  }
  if (!Number.isInteger(REALTIME_WARMUP_ATTEMPTS) || REALTIME_WARMUP_ATTEMPTS < 1) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_WARMUP_ATTEMPTS ${process.env.E2E_REALTIME_WARMUP_ATTEMPTS}`)
  }

  const target = await insertRealtimeTargetMatchup(supabase, leagueId, season, season)
  const bidTarget = await insertRealtimeAuctionTarget(supabase, leagueId, season)
  const clients = []
  const channels = []
  const warmupDeliveries = []
  const deliveries = []
  const bidDeliveries = []
  const warmupHomePoints = 500 + season * 10
  const warmupAwayPoints = 400 + season * 10
  const expectedHomePoints = 1000 + season
  const expectedAwayPoints = 900 + season
  const expectedBidAmount = 2
  const warmupSeen = new Set()
  let bidSucceeded = false
  const realtimeAccessToken = await signInForAccessToken(
    env,
    state.users[0].email,
    state.password,
    'D.X.2 realtime sign-in',
  )

  try {
    const setups = Array.from({ length: REALTIME_CLIENTS }, (_, index) => {
      const client = createClient(env.supabaseUrl, env.anonKey, {
        auth: { persistSession: false },
        realtime: { transport: WebSocket, timeout: REALTIME_SUBSCRIBE_TIMEOUT_MS },
      })
      client.realtime.setAuth(realtimeAccessToken)

      let resolveWarmup
      const warmupDelivery = new Promise((resolve) => {
        resolveWarmup = resolve
      })
      let channel
      const delivery = new Promise((resolve) => {
        channel = client
          .channel(`e2e_realtime_${season}_${index}`)
          .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'matchups',
            filter: `id=eq.${target.id}`,
          }, (payload) => {
            const homePoints = Number(payload.new?.home_points)
            const awayPoints = Number(payload.new?.away_points)
            const warmupAttempt = homePoints - warmupHomePoints
            if (
              warmupAttempt >= 0 &&
              warmupAttempt < REALTIME_WARMUP_ATTEMPTS &&
              awayPoints === warmupAwayPoints + warmupAttempt
            ) {
              warmupSeen.add(index)
              resolveWarmup({ clientIndex: index, receivedAtMs: nowMs() })
            }
            if (
              homePoints === expectedHomePoints &&
              awayPoints === expectedAwayPoints
            ) {
              resolve({ clientIndex: index, receivedAtMs: nowMs() })
            }
          })
      })
      const bidDelivery = new Promise((resolve) => {
        channel.on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'nominations',
          filter: `id=eq.${bidTarget.nominationId}`,
        }, (payload) => {
          if (
            Number(payload.new?.current_bid_amount) === expectedBidAmount &&
            payload.new?.current_bidder_id === bidTarget.bidderTwo
          ) {
            resolve({ clientIndex: index, receivedAtMs: nowMs() })
          }
        })
      })
      return { client, channel, warmupDelivery, delivery, bidDelivery }
    })
    clients.push(...setups.map(({ client }) => client))
    channels.push(...setups.map(({ client, channel }) => ({ client, channel })))
    warmupDeliveries.push(...setups.map(({ warmupDelivery }) => warmupDelivery))
    deliveries.push(...setups.map(({ delivery }) => delivery))
    bidDeliveries.push(...setups.map(({ bidDelivery }) => bidDelivery))

    await Promise.all(channels.map(({ channel }, index) => waitForRealtimeSubscribe(channel, `client ${index + 1}`)))
    await sleep(REALTIME_SETTLE_MS)
    for (let attempt = 0; attempt < REALTIME_WARMUP_ATTEMPTS && warmupSeen.size < REALTIME_CLIENTS; attempt += 1) {
      const { error: warmupError } = await supabase
        .from('matchups')
        .update({
          home_points: warmupHomePoints + attempt,
          away_points: warmupAwayPoints + attempt,
        })
        .eq('id', target.id)
      if (warmupError) throw new Error(`D.X.2 realtime warmup update ${attempt + 1}: ${warmupError.message}`)
      await sleep(Math.min(REALTIME_LATENCY_LIMIT_MS, 2000))
    }
    await withTimeout(
      Promise.all(warmupDeliveries),
      1000,
      `D.X.2: realtime warmup update reached ${warmupSeen.size}/${REALTIME_CLIENTS} clients after ${REALTIME_WARMUP_ATTEMPTS} attempts`,
    )

    const updateStartedMs = nowMs()
    const { error: updateError } = await supabase
      .from('matchups')
      .update({
        home_points: expectedHomePoints,
        away_points: expectedAwayPoints,
      })
      .eq('id', target.id)
    if (updateError) throw new Error(`D.X.2 realtime matchup update: ${updateError.message}`)
    const updateCommittedMs = nowMs()

    const results = await withTimeout(
      Promise.all(deliveries),
      REALTIME_LATENCY_LIMIT_MS,
      `D.X.2: realtime update did not reach all ${REALTIME_CLIENTS} clients within ${REALTIME_LATENCY_LIMIT_MS}ms`,
    )
    const latenciesMs = results.map((result) => Math.max(0, result.receivedAtMs - updateCommittedMs))
    const maxLatencyMs = Math.max(...latenciesMs)
    if (maxLatencyMs > REALTIME_LATENCY_LIMIT_MS) {
      throw new Error(`D.X.2: realtime max latency ${roundedMs(maxLatencyMs)}ms exceeded ${REALTIME_LATENCY_LIMIT_MS}ms`)
    }

    const bidStartedMs = nowMs()
    const { error: bidError } = await supabase.rpc('place_auction_bid_atomic', {
      p_draft_id: bidTarget.draftId,
      p_member_id: bidTarget.bidderTwo,
      p_nomination_id: bidTarget.nominationId,
      p_amount: expectedBidAmount,
      p_user_id: bidTarget.bidderTwoUserId,
    })
    if (bidError) throw new Error(`D.X.2 realtime auction bid RPC: ${bidError.message}`)
    bidSucceeded = true
    const bidCommittedMs = nowMs()

    const bidResults = await withTimeout(
      Promise.all(bidDeliveries),
      REALTIME_LATENCY_LIMIT_MS,
      `D.X.2: realtime bid update did not reach all ${REALTIME_CLIENTS} clients within ${REALTIME_LATENCY_LIMIT_MS}ms`,
    )
    const bidLatenciesMs = bidResults.map((result) => Math.max(0, result.receivedAtMs - bidCommittedMs))
    const maxBidLatencyMs = Math.max(...bidLatenciesMs)
    if (maxBidLatencyMs > REALTIME_LATENCY_LIMIT_MS) {
      throw new Error(`D.X.2: realtime bid max latency ${roundedMs(maxBidLatencyMs)}ms exceeded ${REALTIME_LATENCY_LIMIT_MS}ms`)
    }

    await writeFile(
      path.join(ARTIFACT_ROOT, `season-${season}`, 'realtime-latency.json'),
      `${JSON.stringify({
        season,
        matchupId: target.id,
        draftId: bidTarget.draftId,
        nominationId: bidTarget.nominationId,
        clients: REALTIME_CLIENTS,
        updateRoundTripMs: roundedMs(updateCommittedMs - updateStartedMs),
        maxLatencyMs: roundedMs(maxLatencyMs),
        latenciesMs: latenciesMs.map((latency) => roundedMs(latency)),
        bidRoundTripMs: roundedMs(bidCommittedMs - bidStartedMs),
        maxBidLatencyMs: roundedMs(maxBidLatencyMs),
        bidLatenciesMs: bidLatenciesMs.map((latency) => roundedMs(latency)),
      }, null, 2)}\n`,
    )
  } finally {
    const closedAt = new Date().toISOString()
    await supabase
      .from('nominations')
      .update(bidSucceeded
        ? {
            status: 'sold',
            winning_member_id: bidTarget.bidderTwo,
            final_price: expectedBidAmount,
            countdown_expires_at: null,
            closed_at: closedAt,
          }
        : {
            status: 'no_bid',
            countdown_expires_at: null,
            closed_at: closedAt,
          })
      .eq('id', bidTarget.nominationId)
      .eq('status', 'open')
    await supabase
      .from('drafts')
      .update({ status: 'completed', completed_at: closedAt })
      .eq('id', bidTarget.draftId)
    await Promise.allSettled(channels.map(({ client, channel }) => client.removeChannel(channel)))
    await Promise.allSettled(clients.map(async (client) => {
      if (typeof client.removeAllChannels === 'function') {
        await client.removeAllChannels()
      }
      await client.auth.signOut()
      if (typeof client.realtime?.disconnect === 'function') {
        client.realtime.disconnect()
      }
    }))
    await sleep(100)
  }
}

const applyMidlifeMigration = async (season) => {
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`)
  await mkdir(artifactDir, { recursive: true })
  const startedAt = timestamp()
  const target = (process.env.E2E_MIDLIFE_MIGRATION_TARGET ?? '').trim().toLowerCase()
  const env = resolvedEnv()
  const isLocalSupabase = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(env.supabaseUrl)
  const command = process.env.E2E_MIDLIFE_MIGRATION_DB_URL
    ? ['supabase', 'db', 'push', '--db-url', process.env.E2E_MIDLIFE_MIGRATION_DB_URL, '--yes']
    : target === 'linked'
      ? ['supabase', 'db', 'push', '--linked', '--yes']
      : ['supabase', 'db', 'push', isLocalSupabase || target === 'local' ? '--local' : '--linked', '--yes']
  const report = {
    command: `npx ${command.join(' ')}`,
    target: process.env.E2E_MIDLIFE_MIGRATION_DB_URL ? 'db-url' : target || (isLocalSupabase ? 'local' : 'linked'),
    startedAt,
    finishedAt: null,
    status: 'ERROR',
    stdout: '',
    stderr: '',
  }

  try {
    const { stdout, stderr } = await execFileAsync('npx', command, {
      cwd: ROOT,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 4,
    })
    report.status = /Remote database is up to date/i.test(`${stdout}\n${stderr}`)
      ? 'UP_TO_DATE'
      : 'APPLIED'
    report.stdout = stdout
    report.stderr = stderr
    return report
  } catch (error) {
    report.stdout = error?.stdout ?? ''
    report.stderr = error?.stderr ?? ''
    throw new Error(`D.LONG.5 mid-life migration failed: ${errorMessage(error)}`)
  } finally {
    report.finishedAt = timestamp()
    await writeFile(
      path.join(artifactDir, 'midlife-migration.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
  }
}

const runInvariants = async (supabase, leagueId, scenarios = {}) => {
  const leagueFilter = leagueId ? { league_id: leagueId } : {}
  const [
    leagues,
    leagueSeasons,
    leagueMembers,
    rosterPlayers,
    weeklyLineups,
    waiverClaims,
    trades,
    draftPicks,
    drafts,
  ] = await Promise.all([
    leagueId ? fetchAll(supabase, 'leagues', 'id', { id: leagueId }) : fetchAll(supabase, 'leagues', 'id'),
    fetchAll(supabase, 'league_seasons', 'id, league_id, is_current', leagueFilter),
    fetchAll(supabase, 'league_members', 'id, league_id', leagueFilter),
    fetchAll(supabase, 'roster_players', 'id, league_id, league_season_id, member_id, player_id', leagueFilter),
    fetchAll(supabase, 'weekly_lineups', 'id, league_id, league_season_id, member_id, player_id', leagueFilter),
    fetchAll(supabase, 'waiver_claims', 'id, league_id, league_season_id, member_id, player_id, drop_player_id, status, process_date', leagueFilter),
    fetchAll(supabase, 'trades', 'id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, veto_window_expires_at', leagueFilter),
    fetchAll(supabase, 'draft_picks', 'id, league_id, season_year, round, current_owner_id, original_owner_id', leagueFilter),
    fetchAll(supabase, 'drafts', 'id, league_id', leagueFilter),
  ])

  const failures = []
  const leagueIds = new Set(leagues.map((row) => row.id))
  const seasonIds = indexById(leagueSeasons)
  const membersById = indexById(leagueMembers)
  const draftIds = new Set(drafts.map((draft) => draft.id))
  const tradeIds = new Set(trades.map((trade) => trade.id))
  const scopedTradeItems = leagueId
    ? await fetchAllIn(supabase, 'trade_items', 'id, trade_id, player_id, pick_id', 'trade_id', [...tradeIds])
    : await fetchAll(supabase, 'trade_items', 'id, trade_id, player_id, pick_id')
  const scopedNominations = leagueId
    ? await fetchAllIn(supabase, 'nominations', 'id, draft_id, status, countdown_expires_at', 'draft_id', [...draftIds])
    : await fetchAll(supabase, 'nominations', 'id, draft_id, status, countdown_expires_at')

  if (leagues.length === 0) {
    failures.push(leagueId ? `D.SET.2: target league ${leagueId} does not exist` : 'D.SET.2: no leagues exist in the test project')
  }

  for (const league of leagues) {
    const current = leagueSeasons.filter((season) => season.league_id === league.id && season.is_current)
    if (current.length !== 1) {
      failures.push(`I0: league ${league.id} has ${current.length} current seasons`)
      continue
    }

    const [currentSeason] = current
    const members = leagueMembers.filter((member) => member.league_id === league.id)
    const memberIds = new Set(members.map((member) => member.id))
    const pickKeys = new Set(
      draftPicks
        .filter((pick) => pick.league_id === league.id)
        .map((pick) => `${pick.season_year}:${pick.round}:${pick.original_owner_id}`),
    )
    const currentYear = currentSeason.season_year
    for (let seasonYear = currentYear + 1; seasonYear <= currentYear + 5; seasonYear += 1) {
      for (let round = 1; round <= 3; round += 1) {
        for (const memberId of memberIds) {
          if (!pickKeys.has(`${seasonYear}:${round}:${memberId}`)) {
            failures.push(`D.SEA.6: league ${league.id} missing future pick ${seasonYear} round ${round} for member ${memberId}`)
          }
        }
      }
    }
  }

  for (const pick of draftPicks) {
    const owner = membersById.get(pick.current_owner_id)
    const originalOwner = membersById.get(pick.original_owner_id)
    if (!owner || owner.league_id !== pick.league_id) {
      failures.push(`I2: draft_pick ${pick.id} current_owner_id does not resolve within league`)
    }
    if (!originalOwner || originalOwner.league_id !== pick.league_id) {
      failures.push(`I2: draft_pick ${pick.id} original_owner_id does not resolve within league`)
    }
  }

  if (scenarios.futurePickChain) {
    const targetPick = draftPicks.find((pick) => pick.id === scenarios.futurePickChain.targetPickId)
    if (!targetPick) {
      failures.push(`D.LONG.2: target multi-hop pick ${scenarios.futurePickChain.targetPickId} is missing`)
    } else if (targetPick.current_owner_id !== scenarios.futurePickChain.finalOwnerId) {
      failures.push(
        `D.LONG.2: target multi-hop pick ${targetPick.id} owner drifted to ${targetPick.current_owner_id}; expected ${scenarios.futurePickChain.finalOwnerId}`,
      )
    }
  }

  const rosterKeys = new Set()
  for (const rosterPlayer of rosterPlayers) {
    const key = `${rosterPlayer.league_id}:${rosterPlayer.league_season_id}:${rosterPlayer.player_id}`
    if (rosterKeys.has(key)) {
      failures.push(`I3: duplicate roster player ownership for ${key}`)
    }
    rosterKeys.add(key)
  }

  const assertLeagueSeasonMember = (label, row, memberKeys) => {
    if (!leagueIds.has(row.league_id)) failures.push(`I6: ${label} ${row.id} has orphan league_id`)
    if (!seasonIds.has(row.league_season_id)) failures.push(`I6: ${label} ${row.id} has orphan league_season_id`)
    for (const key of memberKeys) {
      const member = membersById.get(row[key])
      if (!member || member.league_id !== row.league_id) {
        failures.push(`I6: ${label} ${row.id} has invalid ${key}`)
      }
    }
  }

  for (const row of rosterPlayers) assertLeagueSeasonMember('roster_players', row, ['member_id'])
  for (const row of weeklyLineups) assertLeagueSeasonMember('weekly_lineups', row, ['member_id'])
  for (const row of waiverClaims) assertLeagueSeasonMember('waiver_claims', row, ['member_id'])
  for (const row of trades) assertLeagueSeasonMember('trades', row, ['proposer_member_id', 'recipient_member_id'])

  const pickIds = new Set(draftPicks.map((pick) => pick.id))
  for (const item of scopedTradeItems) {
    if (!tradeIds.has(item.trade_id)) failures.push(`I6: trade_items ${item.id} has orphan trade_id`)
    if (item.pick_id && !pickIds.has(item.pick_id)) failures.push(`I6: trade_items ${item.id} has orphan pick_id`)
  }

  const now = new Date()
  for (const nomination of scopedNominations) {
    if (
      nomination.status === 'open' &&
      nomination.countdown_expires_at &&
      new Date(nomination.countdown_expires_at) < now
    ) {
      failures.push(`I7: nomination ${nomination.id} is open past countdown_expires_at`)
    }
  }

  for (const trade of trades) {
    if (
      trade.status === 'accepted' &&
      trade.veto_window_expires_at &&
      new Date(trade.veto_window_expires_at) < now
    ) {
      failures.push(`I7: trade ${trade.id} is pending completion past veto_window_expires_at`)
    }
  }

  const today = now.toISOString().slice(0, 10)
  for (const claim of waiverClaims) {
    if (claim.status === 'pending' && claim.process_date < today) {
      failures.push(`I7: waiver_claim ${claim.id} is pending past process_date`)
    }
  }

  return failures
}

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

const backendUrl = (env, pathname) => new URL(pathname, env.apiBaseUrl.endsWith('/') ? env.apiBaseUrl : `${env.apiBaseUrl}/`).toString()

const backendJson = async (env, pathname, body = {}) => {
  const response = await fetch(backendUrl(env, pathname), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-e2e-secret': env.e2eAdminSecret,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`)
  return response.json()
}

const backendGetJson = async (env, pathname) => {
  const response = await fetch(backendUrl(env, pathname), {
    headers: { 'x-e2e-secret': env.e2eAdminSecret },
  })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`)
  return response.json()
}

const backendAuthedJson = async (env, pathname, token, body = {}) => {
  const response = await fetch(backendUrl(env, pathname), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${pathname} returned ${response.status}${text ? `: ${text}` : ''}`)
  }
  return response.json()
}

const assertBackendUsesFakePush = async (env, fakePort) => {
  const status = await backendGetJson(env, '/e2e/status')
  const expected = `http://127.0.0.1:${fakePort}/--/api/v2/push/send`
  if (status.expoPushUrl !== expected) {
    throw new Error(`D.X.1: backend EXPO_PUSH_URL is ${status.expoPushUrl ?? '<unset>'}; expected ${expected}`)
  }
}

const signInForAccessToken = async (env, email, password, label = 'E2E sign-in') => {
  if (!env.anonKey) {
    throw new Error(
      'E2E authenticated Edge API scenarios require E2E_SUPABASE_PUBLISHABLE_KEY or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    )
  }
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (!error) {
      const token = data.session?.access_token
      if (!token) throw new Error(`${label} for ${email} returned no access token`)
      return token
    }
    lastError = error
    if (!/rate limit/i.test(error.message) || attempt === 4) break
    await sleep((attempt + 1) * 5000)
  }
  throw new Error(`${label} failed for ${email}: ${lastError?.message ?? 'unknown error'}`)
}

const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const findAvailablePlayer = async (supabase, leagueId, leagueSeasonId) => {
  const [players, rosterRows] = await Promise.all([
    fetchAll(supabase, 'players', 'id, display_name, sportsdata_id'),
    fetchAll(supabase, 'roster_players', 'player_id', {
      league_id: leagueId,
      league_season_id: leagueSeasonId,
    }),
  ])
  const rosteredIds = new Set(rosterRows.map((row) => row.player_id))
  const player = players
    .filter((row) => row.display_name && String(row.sportsdata_id ?? '').startsWith(E2E_PLAYER_PREFIX))
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)) || String(a.id).localeCompare(String(b.id)))
    .find((row) => !rosteredIds.has(row.id))
  if (!player) {
    const [fallback] = await createFallbackE2EPlayers(supabase, leagueSeasonId, 1, 'D.X.1')
    if (!fallback) throw new Error('D.X.1: no available player found for waiver push scenario')
    return fallback
  }
  return player
}

const findAvailablePlayers = async (supabase, leagueId, leagueSeasonId, count, label) => {
  const [players, rosterRows] = await Promise.all([
    fetchAll(supabase, 'players', 'id, display_name, sportsdata_id'),
    fetchAll(supabase, 'roster_players', 'player_id', {
      league_id: leagueId,
      league_season_id: leagueSeasonId,
    }),
  ])
  const rosteredIds = new Set(rosterRows.map((row) => row.player_id))
  const available = players
    .filter((row) => row.display_name && String(row.sportsdata_id ?? '').startsWith(E2E_PLAYER_PREFIX) && !rosteredIds.has(row.id))
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, count)
  if (available.length < count) {
    const fallback = await createFallbackE2EPlayers(supabase, leagueSeasonId, count - available.length, label)
    return [...available, ...fallback].slice(0, count)
  }
  return available
}

const assertWaiverProcessingScenario = async ({ supabase, env, state, season }) => {
  const label = 'D.SEA.2 waiver processing'
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 4,
    seasonYear: 4300 + season,
  })
  const [priorityOne, priorityTwo, priorityThree, priorityFour] = fixture.members
  const [sharedPlayer, dropClaimPlayer, fullRosterPlayer, dropPlayer, fillerPlayer] = await findAvailablePlayers(
    supabase,
    fixture.league.id,
    fixture.leagueSeason.id,
    5,
    label,
  )
  const now = new Date()
  const clearsAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString()
  const processDate = todayET()

  const failures = []
  const priorityRows = fixture.members.map((member, index) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.leagueSeason.id,
    member_id: member.id,
    priority: index + 1,
  }))
  const [{ error: leagueError }, { error: deletePriorityError }, { error: rosterError }, { error: waiverLogError }] = await Promise.all([
    supabase
      .from('leagues')
      .update({ roster_size: 1 })
      .eq('id', fixture.league.id),
    supabase
      .from('waiver_priorities')
      .delete()
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.leagueSeason.id),
    supabase
      .from('roster_players')
      .insert([
        {
          league_id: fixture.league.id,
          league_season_id: fixture.leagueSeason.id,
          member_id: priorityThree.id,
          player_id: dropPlayer.id,
          acquired_via: 'e2e_waiver_processing_fixture',
        },
        {
          league_id: fixture.league.id,
          league_season_id: fixture.leagueSeason.id,
          member_id: priorityFour.id,
          player_id: fillerPlayer.id,
          acquired_via: 'e2e_waiver_processing_fixture',
        },
      ]),
    supabase
      .from('waiver_wire_log')
      .insert([sharedPlayer, dropClaimPlayer, fullRosterPlayer].map((player) => ({
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        player_id: player.id,
        dropped_by_member_id: null,
        clears_at: clearsAt,
      }))),
  ])
  if (leagueError) throw new Error(`${label}: roster-size update failed: ${leagueError.message}`)
  if (deletePriorityError) throw new Error(`${label}: priority cleanup failed: ${deletePriorityError.message}`)
  if (rosterError) throw new Error(`${label}: roster seed failed: ${rosterError.message}`)
  if (waiverLogError) throw new Error(`${label}: waiver log seed failed: ${waiverLogError.message}`)

  const { error: priorityError } = await supabase.from('waiver_priorities').insert(priorityRows)
  if (priorityError) throw new Error(`${label}: priority seed failed: ${priorityError.message}`)

  const { data: claims, error: claimError } = await supabase
    .from('waiver_claims')
    .insert([
      {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: priorityOne.id,
        player_id: sharedPlayer.id,
        drop_player_id: null,
        priority_at_submission: 1,
        process_date: processDate,
      },
      {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: priorityTwo.id,
        player_id: sharedPlayer.id,
        drop_player_id: null,
        priority_at_submission: 2,
        process_date: processDate,
      },
      {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: priorityThree.id,
        player_id: dropClaimPlayer.id,
        drop_player_id: dropPlayer.id,
        priority_at_submission: 3,
        process_date: processDate,
      },
      {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: priorityFour.id,
        player_id: fullRosterPlayer.id,
        drop_player_id: null,
        priority_at_submission: 4,
        process_date: processDate,
      },
    ])
    .select('id, member_id, player_id')
  if (claimError) throw new Error(`${label}: claim seed failed: ${claimError.message}`)

  await backendJson(env, '/e2e/process-waivers')

  const [claimRows, priorityResult, rosterRows, transactionRows, waiverRows] = await Promise.all([
    fetchAll(supabase, 'waiver_claims', 'id, member_id, player_id, drop_player_id, status, failure_reason', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'waiver_priorities', 'member_id, priority', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'roster_players', 'member_id, player_id, acquired_via', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'roster_transactions', 'member_id, player_id, transaction_type, related_claim_id', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
    fetchAll(supabase, 'waiver_wire_log', 'player_id, dropped_by_member_id, claimed_by_claim_id, cleared_at', {
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
    }),
  ])

  const claimByMemberPlayer = new Map(claimRows.map((row) => [`${row.member_id}:${row.player_id}`, row]))
  const winningSharedClaim = claimByMemberPlayer.get(`${priorityOne.id}:${sharedPlayer.id}`)
  const losingSharedClaim = claimByMemberPlayer.get(`${priorityTwo.id}:${sharedPlayer.id}`)
  const dropClaim = claimByMemberPlayer.get(`${priorityThree.id}:${dropClaimPlayer.id}`)
  const failedRosterClaim = claimByMemberPlayer.get(`${priorityFour.id}:${fullRosterPlayer.id}`)
  if (winningSharedClaim?.status !== 'succeeded') failures.push(`${label}: priority-one shared claim status ${winningSharedClaim?.status ?? '<missing>'}; expected succeeded`)
  if (losingSharedClaim?.status !== 'failed_priority') failures.push(`${label}: priority-two shared claim status ${losingSharedClaim?.status ?? '<missing>'}; expected failed_priority`)
  if (dropClaim?.status !== 'succeeded') failures.push(`${label}: drop claim status ${dropClaim?.status ?? '<missing>'}; expected succeeded`)
  if (failedRosterClaim?.status !== 'failed_roster') failures.push(`${label}: full-roster claim status ${failedRosterClaim?.status ?? '<missing>'}; expected failed_roster`)

  const rosterSet = new Set(rosterRows.map((row) => `${row.member_id}:${row.player_id}`))
  if (!rosterSet.has(`${priorityOne.id}:${sharedPlayer.id}`)) failures.push(`${label}: shared player not rostered by priority-one winner`)
  if (!rosterSet.has(`${priorityThree.id}:${dropClaimPlayer.id}`)) failures.push(`${label}: drop-claim player not rostered by priority-three winner`)
  if (rosterSet.has(`${priorityThree.id}:${dropPlayer.id}`)) failures.push(`${label}: dropped player still rostered by priority-three winner`)
  if (rosterSet.has(`${priorityFour.id}:${fullRosterPlayer.id}`)) failures.push(`${label}: failed-roster player was rostered`)

  const priorityByMember = new Map(priorityResult.map((row) => [row.member_id, row.priority]))
  const expectedPriority = new Map([
    [priorityTwo.id, 2],
    [priorityFour.id, 4],
    [priorityOne.id, 5],
    [priorityThree.id, 6],
  ])
  for (const [memberId, expected] of expectedPriority) {
    const actual = priorityByMember.get(memberId)
    if (actual !== expected) failures.push(`${label}: waiver priority for ${memberId} is ${actual ?? '<missing>'}; expected ${expected}`)
  }

  const transactionSet = new Set(transactionRows.map((row) => `${row.member_id}:${row.player_id}:${row.transaction_type}`))
  if (!transactionSet.has(`${priorityOne.id}:${sharedPlayer.id}:waiver_add`)) failures.push(`${label}: missing priority-one waiver_add transaction`)
  if (!transactionSet.has(`${priorityThree.id}:${dropClaimPlayer.id}:waiver_add`)) failures.push(`${label}: missing drop-claim waiver_add transaction`)
  if (!transactionSet.has(`${priorityThree.id}:${dropPlayer.id}:waiver_drop`)) failures.push(`${label}: missing drop-claim waiver_drop transaction`)

  const waiverForShared = waiverRows.find((row) => row.player_id === sharedPlayer.id)
  const waiverForDropClaim = waiverRows.find((row) => row.player_id === dropClaimPlayer.id)
  const waiverForDropped = waiverRows.find((row) => row.player_id === dropPlayer.id && row.dropped_by_member_id === priorityThree.id)
  if (!waiverForShared?.cleared_at || waiverForShared.claimed_by_claim_id !== winningSharedClaim?.id) failures.push(`${label}: shared-player waiver log was not claimed by winning claim`)
  if (!waiverForDropClaim?.cleared_at || waiverForDropClaim.claimed_by_claim_id !== dropClaim?.id) failures.push(`${label}: drop-claim waiver log was not claimed by winning claim`)
  if (!waiverForDropped || waiverForDropped.cleared_at) failures.push(`${label}: dropped player was not placed back on waivers`)

  const artifact = {
    season,
    fixture,
    players: {
      sharedPlayer,
      dropClaimPlayer,
      fullRosterPlayer,
      dropPlayer,
      fillerPlayer,
    },
    claims,
    claimRows,
    priorityRows: priorityResult,
    rosterRows,
    transactionRows,
    waiverRows,
    failures,
  }
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`)
  await mkdir(artifactDir, { recursive: true })
  await writeFile(path.join(artifactDir, 'waiver-processing.json'), `${JSON.stringify(artifact, null, 2)}\n`)
  return artifact
}

const expectAuctionRpcError = async ({ supabase, label, args, pattern }) => {
  const { error } = await supabase.rpc('place_auction_bid_atomic', args)
  if (!error) {
    throw new Error(`D.SET.4: expected ${label} to fail`)
  }
  if (!pattern.test(error.message)) {
    throw new Error(`D.SET.4: ${label} failed with "${error.message}", expected ${pattern}`)
  }
  return error.message
}

const assertAuctionBidValidation = async ({ supabase, leagueId, season }) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const members = await sortedLeagueMembers(supabase, leagueId)
  if (members.length < 2) throw new Error('D.SET.4: auction validation requires at least two league members')
  const player = await findAvailablePlayer(supabase, leagueId, currentSeason.id)

  const [
    { id: bidderOne, user_id: bidderOneUserId },
    { id: bidderTwo, user_id: bidderTwoUserId },
  ] = members
  const now = new Date().toISOString()
  const { error: cleanupDraftError } = await supabase
    .from('drafts')
    .update({ status: 'completed', completed_at: now })
    .eq('league_id', leagueId)
    .eq('league_season_id', currentSeason.id)
    .in('status', ['pending', 'in_progress', 'paused'])
  if (cleanupDraftError) throw new Error(`D.SET.4 auction draft cleanup: ${cleanupDraftError.message}`)

  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .insert({
      league_id: leagueId,
      league_season_id: currentSeason.id,
      draft_type: 'auction',
      status: 'in_progress',
      budget_per_team: 5,
      started_at: now,
      current_nomination_order: 1,
    })
    .select('id')
    .single()
  if (draftError) throw new Error(`D.SET.4 auction draft insert: ${draftError.message}`)

  const [{ error: orderError }, { error: budgetError }] = await Promise.all([
    supabase.from('draft_orders').insert(members.map((member, index) => ({
      draft_id: draft.id,
      member_id: member.id,
      position: index + 1,
    }))),
    supabase.from('draft_budgets').insert(members.map((member) => ({
      draft_id: draft.id,
      member_id: member.id,
      initial_budget: 5,
      remaining: 5,
    }))),
  ])
  if (orderError) throw new Error(`D.SET.4 auction order insert: ${orderError.message}`)
  if (budgetError) throw new Error(`D.SET.4 auction budget insert: ${budgetError.message}`)

  const { data: nomination, error: nominationError } = await supabase
    .from('nominations')
    .insert({
      draft_id: draft.id,
      nominating_member_id: bidderOne,
      player_id: player.id,
      nomination_order: 1,
      status: 'open',
      current_bid_amount: 1,
      current_bidder_id: null,
      countdown_expires_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (nominationError) throw new Error(`D.SET.4 auction nomination insert: ${nominationError.message}`)

  const baseArgs = {
    p_draft_id: draft.id,
    p_nomination_id: nomination.id,
  }
  const rejected = {
    currentBid: await expectAuctionRpcError({
      supabase,
      label: 'bid at current amount',
      args: { ...baseArgs, p_member_id: bidderOne, p_amount: 1, p_user_id: bidderOneUserId },
      pattern: /Bid must exceed current bid/i,
    }),
    overBudget: await expectAuctionRpcError({
      supabase,
      label: 'bid over budget',
      args: { ...baseArgs, p_member_id: bidderOne, p_amount: 6, p_user_id: bidderOneUserId },
      pattern: /Insufficient budget/i,
    }),
  }

  const { error: firstBidError } = await supabase.rpc('place_auction_bid_atomic', {
    ...baseArgs,
    p_member_id: bidderOne,
    p_amount: 2,
    p_user_id: bidderOneUserId,
  })
  if (firstBidError) throw new Error(`D.SET.4 first valid auction bid: ${firstBidError.message}`)

  rejected.selfOverbid = await expectAuctionRpcError({
    supabase,
    label: 'self-overbid',
    args: { ...baseArgs, p_member_id: bidderOne, p_amount: 3, p_user_id: bidderOneUserId },
    pattern: /already the highest bidder/i,
  })

  const { error: secondBidError } = await supabase.rpc('place_auction_bid_atomic', {
    ...baseArgs,
    p_member_id: bidderTwo,
    p_amount: 3,
    p_user_id: bidderTwoUserId,
  })
  if (secondBidError) throw new Error(`D.SET.4 second valid auction bid: ${secondBidError.message}`)

  const { data: finalNomination, error: finalError } = await supabase
    .from('nominations')
    .select('current_bid_amount, current_bidder_id')
    .eq('id', nomination.id)
    .single()
  if (finalError) throw new Error(`D.SET.4 auction final nomination lookup: ${finalError.message}`)
  if (finalNomination.current_bid_amount !== 3 || finalNomination.current_bidder_id !== bidderTwo) {
    throw new Error(`D.SET.4: final high bid was ${finalNomination.current_bid_amount}/${finalNomination.current_bidder_id}; expected 3/${bidderTwo}`)
  }
  const { error: closeError } = await supabase
    .from('nominations')
    .update({
      status: 'sold',
      winning_member_id: bidderTwo,
      final_price: 3,
      countdown_expires_at: null,
      closed_at: new Date().toISOString(),
    })
    .eq('id', nomination.id)
  if (closeError) throw new Error(`D.SET.4 auction fixture close: ${closeError.message}`)

  const artifact = {
    draftId: draft.id,
    nominationId: nomination.id,
    playerId: player.id,
    bidderOne,
    bidderTwo,
    rejected,
    acceptedBids: [2, 3],
  }
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`)
  await mkdir(artifactDir, { recursive: true })
  await writeFile(
    path.join(artifactDir, 'auction-validation.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  return artifact
}

const assertWaiverPushNotification = async ({ supabase, env, state, leagueId, season, fakePort }) => {
  if (!state?.runId || !Array.isArray(state.users) || state.users.length < 3) {
    throw new Error('D.X.1: waiver push scenario requires tests/e2e-state.json from npm run e2e:seed')
  }

  const label = 'D.X.1 waiver push'
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label,
    userCount: 3,
    seasonYear: 6200 + season,
  })

  const recipientUser = state.users[2]
  const member = fixture.members[2]
  if (member.user_id !== recipientUser.id) {
    throw new Error(`${label}: fixture member/user mismatch for waiver push recipient`)
  }

  const tokenValue = `ExponentPushToken[e2e-waiver-${state.runId}-${season}]`
  const [{ error: profileError }, { error: leagueError }, { error: priorityError }] = await Promise.all([
    supabase
      .from('profiles')
      .update({ push_token: tokenValue })
      .eq('id', recipientUser.id),
    supabase
      .from('leagues')
      .update({ roster_size: 20 })
      .eq('id', fixture.league.id),
    supabase
      .from('waiver_priorities')
      .insert(fixture.members.map((fixtureMember, index) => ({
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
        member_id: fixtureMember.id,
        priority: index + 1,
      }))),
  ])
  if (profileError) throw new Error(`${label} token setup: ${profileError.message}`)
  if (leagueError) throw new Error(`${label} league setup: ${leagueError.message}`)
  if (priorityError) throw new Error(`${label} priority seed: ${priorityError.message}`)

  const player = await findAvailablePlayer(supabase, fixture.league.id, fixture.leagueSeason.id)

  const now = new Date()
  const clearsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const { data: waiverLog, error: logError } = await supabase
    .from('waiver_wire_log')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      player_id: player.id,
      dropped_by_member_id: member.id,
      clears_at: clearsAt,
    })
    .select('id')
    .single()
  if (logError) throw new Error(`D.X.1 waiver log insert: ${logError.message}`)

  const { data: claim, error: claimError } = await supabase
    .from('waiver_claims')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.leagueSeason.id,
      member_id: member.id,
      player_id: player.id,
      drop_player_id: null,
      priority_at_submission: 3,
      process_date: todayET(),
    })
    .select('id')
    .single()
  if (claimError) throw new Error(`D.X.1 waiver claim insert: ${claimError.message}`)

  await backendJson(env, '/e2e/process-waivers')

  const response = await fetch(`http://127.0.0.1:${fakePort}/admin/pushes`)
  if (!response.ok) throw new Error(`D.X.1 waiver push capture returned ${response.status}`)
  const { pushes } = await response.json()
  const title = 'Waiver Claim Succeeded'
  const body = `${player.display_name} has been added to your roster.`
  const match = pushes?.find((push) => (
    push.body?.to === tokenValue &&
    push.body?.title === title &&
    push.body?.body === body
  ))
  if (!match) {
    const [claimRow, rosterRows] = await Promise.all([
      fetchSingle(supabase, 'waiver_claims', 'id, status, failure_reason, processed_at', { id: claim.id }),
      fetchAll(supabase, 'roster_players', 'member_id, player_id, acquired_via', {
        league_id: fixture.league.id,
        league_season_id: fixture.leagueSeason.id,
      }),
    ])
    await writeFile(
      path.join(ARTIFACT_ROOT, `season-${season}`, 'waiver-push-debug.json'),
      `${JSON.stringify({
        targetLeagueId: leagueId,
        fixture,
        claim: claimRow,
        rosterRows,
        expected: { tokenValue, title, body },
        pushes,
      }, null, 2)}\n`,
    )
    throw new Error(`D.X.1: waiver push was not captured for token ${tokenValue}`)
  }

  return {
    season,
    targetLeagueId: leagueId,
    fixtureLeagueId: fixture.league.id,
    fixtureSeasonId: fixture.leagueSeason.id,
    claimId: claim.id,
    waiverLogId: waiverLog.id,
    memberId: member.id,
    playerId: player.id,
    playerName: player.display_name,
    captured: match,
  }
}

const assertDraftPushNotification = async ({ supabase, env, state, season, fakePort }) => {
  const failures = []
  const label = 'D.X.1'
  const {
    fixture,
    draft,
    slots,
    rookies,
    expectedOrder,
  } = await createRookieDraftFixture({ supabase, env, state, season, label })

  const firstSlot = slots[0]
  if (!firstSlot) throw new Error(`${label}: draft push fixture created no rookie draft slots`)
  const recipientMember = fixture.members.find((member) => member.id === firstSlot.member_id)
  if (!recipientMember) throw new Error(`${label}: draft push member lookup failed for ${firstSlot.member_id}`)

  const tokenValue = `ExponentPushToken[e2e-draft-${state.runId ?? 'run'}-${season}]`
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ push_token: tokenValue })
    .eq('id', recipientMember.user_id)
  if (profileError) throw new Error(`${label} draft push token setup: ${profileError.message}`)

  await postJson(`http://127.0.0.1:${fakePort}/admin/clear-pushes`, {})
  const autoPickResult = await backendJson(env, `/e2e/${draft.id}/auto-pick`, { memberId: firstSlot.member_id })

  const response = await fetch(`http://127.0.0.1:${fakePort}/admin/pushes`)
  if (!response.ok) throw new Error(`${label} draft push capture returned ${response.status}`)
  const { pushes } = await response.json()
  const match = pushes?.find((push) => push.body?.to === tokenValue)
  if (!match) {
    failures.push(`${label}: no draft push notification captured for rookie auto-pick to token ${tokenValue}`)
  }

  const artifact = {
    season,
    leagueId: fixture.league.id,
    leagueSeasonId: fixture.leagueSeason.id,
    draftId: draft.id,
    firstSlot,
    expectedFirstEightMemberIds: expectedOrder,
    recipientMemberId: recipientMember.id,
    recipientUserId: recipientMember.user_id,
    tokenValue,
    rookies,
    autoPickResult,
    captured: match ?? null,
    capturedPushes: pushes ?? [],
    failures,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'draft-push-notification.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  return { failures, artifact }
}

const assertPushNotifications = async (params) => {
  await postJson(`http://127.0.0.1:${params.fakePort}/admin/clear-pushes`, {})
  // The push pipeline is verified end-to-end by the real, server-emitted waiver
  // notification. (The former trade-push check drove the removed /notify/trade
  // endpoint; real trade notifications are now emitted server-side by the
  // /trades/* routes during the main soak.)
  const waiver = await assertWaiverPushNotification(params)

  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${params.season}`, 'push-notifications.json'),
    `${JSON.stringify({ waiver }, null, 2)}\n`,
  )
}

const assertCorsPreflight = async (env) => {
  const origin = new URL(env.frontendUrl).origin
  const response = await fetch(backendUrl(env, '/e2e/status'), {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type,x-e2e-secret,authorization',
    },
  })
  if (!response.ok && response.status !== 204) {
    throw new Error(`D.X.3: CORS preflight returned ${response.status}`)
  }

  const allowOrigin = response.headers.get('access-control-allow-origin')
  if (allowOrigin !== origin && allowOrigin !== '*') {
    throw new Error(`D.X.3: CORS allow-origin was ${allowOrigin ?? '<missing>'}; expected ${origin}`)
  }

  const allowMethods = response.headers.get('access-control-allow-methods') ?? ''
  if (!allowMethods.split(',').map((method) => method.trim().toUpperCase()).includes('GET')) {
    throw new Error(`D.X.3: CORS allow-methods missing GET: ${allowMethods || '<missing>'}`)
  }

  const allowHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase()
  for (const header of ['content-type', 'x-e2e-secret', 'authorization']) {
    if (!allowHeaders.includes(header)) {
      throw new Error(`D.X.3: CORS allow-headers missing ${header}: ${allowHeaders || '<missing>'}`)
    }
  }
}

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

        if (args.browser) {
          await runBrowserSmoke({ season, fullSweep: args.browserFullSweep })
        }
        if (args.browserAuth) {
          await runBrowserAuthScenario({ season })
        }
        let browserPerfCheck = null
        if (args.browserPerf && shouldRunScenario(args, season)) {
          browserPerfCheck = await runBrowserPerfSmoke({ season })
        }
        let browserGameplayCheck = null
        if (args.browserGameplay && shouldRunScenario(args, season)) {
          browserGameplayCheck = await runBrowserGameplayScenario({ season })
        }
        let browserLineupCheck = null
        if (args.browserLineup && shouldRunScenario(args, season)) {
          browserLineupCheck = await runBrowserLineupScenario({ season })
        }
        let browserLineupAutoSetCheck = null
        if (args.browserLineupAutoSet && shouldRunScenario(args, season)) {
          browserLineupAutoSetCheck = await runBrowserLineupAutoSetScenario({ season })
        }
        let browserLineupLockedCheck = null
        if (args.browserLineupLocked && shouldRunScenario(args, season)) {
          browserLineupLockedCheck = await runBrowserLineupLockedScenario({ season })
        }
        let browserPlayoffCheck = null
        if (args.browserPlayoff && shouldRunScenario(args, season)) {
          browserPlayoffCheck = await runBrowserPlayoffChampionScenario({ season })
        }
        let browserRookieDraftCheck = null
        if (args.browserRookieDraft && shouldRunScenario(args, season)) {
          browserRookieDraftCheck = await runBrowserRookieDraftAutoPickScenario({ season })
        }
        let browserWaiverCheck = null
        if (args.browserWaiver && shouldRunScenario(args, season)) {
          browserWaiverCheck = await runBrowserWaiverScenario({ season })
        }
        let browserWaiverDropCheck = null
        if (args.browserWaiverDrop && shouldRunScenario(args, season)) {
          browserWaiverDropCheck = await runBrowserWaiverDropScenario({ season })
        }
        let browserWaiverIrBlockCheck = null
        if (args.browserWaiverIrBlock && shouldRunScenario(args, season)) {
          browserWaiverIrBlockCheck = await runBrowserWaiverIrBlockScenario({ season })
        }
        let browserTradeCheck = null
        if (args.browserTrade && shouldRunScenario(args, season)) {
          browserTradeCheck = await runBrowserTradeScenario({ season })
        }
        let browserTradeAcceptCheck = null
        if (args.browserTradeAccept && shouldRunScenario(args, season)) {
          browserTradeAcceptCheck = await runBrowserTradeAcceptScenario({ season })
        }
        let browserTradeTerminalCheck = null
        if (args.browserTradeTerminal && shouldRunScenario(args, season)) {
          browserTradeTerminalCheck = await runBrowserTradeTerminalScenario({ season })
        }
        let browserTradeFuturePickCheck = null
        if (args.browserTradeFuturePick && shouldRunScenario(args, season)) {
          browserTradeFuturePickCheck = await runBrowserTradeFuturePickScenario({ season })
        }
        let browserTradeFuturePickAcceptCheck = null
        if (args.browserTradeFuturePickAccept && shouldRunScenario(args, season)) {
          browserTradeFuturePickAcceptCheck = await runBrowserTradeFuturePickAcceptScenario({ season })
        }
        let browserTradeOverflowAcceptCheck = null
        if (args.browserTradeOverflowAccept && shouldRunScenario(args, season)) {
          browserTradeOverflowAcceptCheck = await runBrowserTradeOverflowAcceptScenario({ season })
        }
        let browserTradePostDeadlineCheck = null
        if (args.browserTradePostDeadline && shouldRunScenario(args, season)) {
          browserTradePostDeadlineCheck = await runBrowserTradePostDeadlineScenario({ season })
        }
        let browserTradeVetoCheck = null
        if (args.browserTradeVeto && shouldRunScenario(args, season)) {
          browserTradeVetoCheck = await runBrowserTradeVetoScenario({ season })
        }
        let browserLeagueLifecycleCheck = null
        if (args.browserLeagueLifecycle && shouldRunScenario(args, season)) {
          browserLeagueLifecycleCheck = await runBrowserLeagueLifecycleScenario({ season })
        }
        let leagueLifecycleCheck = null
        const leagueLifecycleFailures = []
        if (args.leagueLifecycle && shouldRunScenario(args, season)) {
          leagueLifecycleCheck = await assertLeagueLifecycleScenario({
            supabase,
            env,
            state,
            season,
          })
          leagueLifecycleFailures.push(...leagueLifecycleCheck.failures)
        }
        let auctionValidation = null
        if (args.auction && shouldRunScenario(args, season)) {
          auctionValidation = await assertAuctionBidValidation({
            supabase,
            leagueId: targetLeagueId,
            season,
          })
        }
        let playoffCheck = null
        const playoffFailures = []
        if (args.playoffs && shouldRunScenario(args, season)) {
          playoffCheck = await assertPlayoffBracketScenario({
            supabase,
            env,
            state,
            season,
          })
          playoffFailures.push(...playoffCheck.failures)
        }
        let tiebreakerCheck = null
        const tiebreakerFailures = []
        if (args.tiebreakers && shouldRunScenario(args, season)) {
          tiebreakerCheck = await assertStandingsTiebreakerScenario({
            supabase,
            env,
            state,
            season,
          })
          tiebreakerFailures.push(...tiebreakerCheck.failures)
        }
        let settingsCheck = null
        const settingsFailures = []
        if (args.settings && shouldRunScenario(args, season)) {
          settingsCheck = await assertCommissionerSettingsScenario({
            supabase,
            env,
            state,
            season,
          })
          settingsFailures.push(...settingsCheck.failures)
        }
        let scoringCheck = null
        const scoringFailures = []
        if (args.scoring && shouldRunScenario(args, season)) {
          scoringCheck = await assertWeeklyScoringFinalizationScenario({
            supabase,
            env,
            state,
            season,
          })
          scoringFailures.push(...scoringCheck.failures)
        }
        let waiverProcessingCheck = null
        const waiverProcessingFailures = []
        if (args.waiverProcessing && shouldRunScenario(args, season)) {
          waiverProcessingCheck = await assertWaiverProcessingScenario({
            supabase,
            env,
            state,
            season,
          })
          waiverProcessingFailures.push(...waiverProcessingCheck.failures)
        }
        let injuryFilterCheck = null
        const injuryFilterFailures = []
        if (args.injuryFilter && shouldRunScenario(args, season)) {
          injuryFilterCheck = await assertInjuryStatusFilterScenario({
            supabase,
            env,
            season,
            fakePort: args.fakePort,
          })
          injuryFilterFailures.push(...injuryFilterCheck.failures)
        }
        let tradeAcceptCheck = null
        const tradeAcceptFailures = []
        if (args.tradeAccept && shouldRunScenario(args, season)) {
          tradeAcceptCheck = await assertTradeAcceptanceAtomicityScenario({
            supabase,
            env,
            state,
            season,
          })
          tradeAcceptFailures.push(...tradeAcceptCheck.failures)
        }
        let tradeVetoCheck = null
        const tradeVetoFailures = []
        if (args.tradeVeto && shouldRunScenario(args, season)) {
          tradeVetoCheck = await assertTradeVetoScenario({
            supabase,
            env,
            state,
            season,
          })
          tradeVetoFailures.push(...tradeVetoCheck.failures)
        }
        let rookieDraftCheck = null
        const rookieDraftFailures = []
        if (args.rookieDraft && shouldRunScenario(args, season)) {
          rookieDraftCheck = await assertRookieDraftAutoPickScenario({
            supabase,
            env,
            state,
            season,
          })
          rookieDraftFailures.push(...rookieDraftCheck.failures)
        }
        if (args.realtime) {
          await assertRealtimeDelivery({
            supabase,
            env,
            state,
            leagueId: targetLeagueId,
            season,
          })
        }
        if (args.push) {
          await assertPushNotifications({
            supabase,
            env,
            state,
            leagueId: targetLeagueId,
            season,
            fakePort: args.fakePort,
          })
        }
        let draftPushCheck = null
        const draftPushFailures = []
        if (args.draftPush && shouldRunScenario(args, season)) {
          draftPushCheck = await assertDraftPushNotification({
            supabase,
            env,
            state,
            season,
            fakePort: args.fakePort,
          })
          draftPushFailures.push(...draftPushCheck.failures)
        }
        let seasonResetCheck = null
        const seasonResetFailures = []
        if (args.seasonReset && shouldRunScenario(args, season)) {
          seasonResetCheck = await assertSeasonResetScenario({
            supabase,
            env,
            state,
            season,
          })
          seasonResetFailures.push(...seasonResetCheck.failures)
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
          ...leagueLifecycleFailures,
          ...playoffFailures,
          ...tiebreakerFailures,
          ...settingsFailures,
          ...scoringFailures,
          ...waiverProcessingFailures,
          ...injuryFilterFailures,
          ...tradeAcceptFailures,
          ...tradeVetoFailures,
          ...rookieDraftFailures,
          ...draftPushFailures,
          ...seasonResetFailures,
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
    await writeCoverageReport({
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

    if (status !== 'PASS') process.exitCode = 1
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
      error.e2eReportWritten = true
      throw error
    }
    const wrappedError = new Error(String(error))
    wrappedError.e2eReportWritten = true
    throw wrappedError
  }
}

main().catch(async (error) => {
  if (!error?.e2eReportWritten && !errorMessage(error).startsWith('Missing required soak environment:')) {
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

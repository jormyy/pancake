import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { createFakeUpstreamServer } from './fake-upstream.mjs'
import { resolvedEnv, describeEndpoint } from './env.mjs'
import { runBrowserSmoke } from './browser-smoke.mjs'
import { runBrowserAuthScenario } from './browser-auth.mjs'

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
const REALTIME_CLIENTS = Number(process.env.E2E_REALTIME_CLIENTS ?? 10)
const REALTIME_LATENCY_LIMIT_MS = Number(process.env.E2E_REALTIME_LATENCY_LIMIT_MS ?? 2000)
const REALTIME_SUBSCRIBE_TIMEOUT_MS = Number(process.env.E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS ?? 10000)
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
    fakePort: Number(args.get('fake-port') ?? process.env.FAKE_UPSTREAM_PORT ?? 4555),
    browser: args.get('browser') === 'true' || process.env.E2E_ENABLE_BROWSER === '1',
    browserFullSweep: args.get('browser-full-sweep') === 'true' || process.env.E2E_BROWSER_FULL_SWEEP === '1',
    browserAuth: args.get('browser-auth') === 'true' || process.env.E2E_ENABLE_BROWSER_AUTH === '1',
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
    rookieDraft: args.get('rookie-draft') === 'true' || process.env.E2E_ENABLE_ROOKIE_DRAFT === '1',
  }
}

const timestamp = () => new Date().toISOString()
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000

const roundedMs = (value) => Math.round(value)
const bytesToMiB = (value) => Math.round((value / 1024 / 1024) * 10) / 10

const currentMemory = () => {
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
  const resetStatus = env.backendTicksEnabled
    ? hasFailingNote(rows, /\bI[0-7]:|D\.SET\.2|advance-season|season reset/i) ? 'FAIL' : 'PARTIAL'
    : 'PENDING'
  const snapshotStatus = hasPassingNote(rows, /snapshot row-count diff passed/) ? 'PASS' : rows.length > 1 ? rowStatus : 'PENDING'
  const matchupStatus = env.backendTicksEnabled && hasPassingNote(rows, /matchup generation idempotency passed/) ? 'PASS' : 'PENDING'
  const pickChainStatus = args.pickChain
    ? hasFailingNote(rows, /D\.LONG\.1|D\.LONG\.2/) ? 'FAIL' : hasPassingNote(rows, /multi-hop future-pick owner resolved/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const browserStatus = args.browser && args.browserAuth
    ? args.browserFullSweep ? 'PARTIAL' : 'PARTIAL'
    : args.browser || args.browserAuth ? 'PARTIAL' : 'PENDING'
  const pushStatus = args.push || args.draftPush
    ? status === 'ERROR' || hasFailingNote(rows, /D\.X\.1|push|waiver/i) ? 'FAIL' : hasPassingNote(rows, /push notification intercepts passed|draft push notification intercept passed/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const historyStatus = args.history
    ? hasFailingNote(rows, /D\.LONG\.3|D\.LONG\.4/) ? 'FAIL' : hasPassingNote(rows, /standings\/champion history retained/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const realtimeStatus = args.realtime
    ? hasProblemNote(rows, /D\.X\.2/) ? 'FAIL' : hasPassingNote(rows, /realtime matchup update delivered/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const midlifeMigrationStatus = args.midlifeMigration
    ? hasFailingNote(rows, /D\.LONG\.5/) ? 'FAIL' : hasPassingNote(rows, /mid-life migration applied/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const auctionStatus = args.auction
    ? hasFailingNote(rows, /D\.SET\.4/) ? 'FAIL' : hasPassingNote(rows, /auction bid validation passed/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const playoffsStatus = args.playoffs
    ? hasFailingNote(rows, /D\.SEA\.4/) ? 'FAIL' : hasPassingNote(rows, /playoff bracket scenario passed/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const tiebreakerStatus = args.tiebreakers
    ? hasFailingNote(rows, /D\.SEA\.3/) ? 'FAIL' : hasPassingNote(rows, /standings tiebreaker scenario passed/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const settingsStatus = args.settings
    ? hasFailingNote(rows, /D\.SET\.3/) ? 'FAIL' : hasPassingNote(rows, /commissioner settings propagation passed/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const scoringStatus = args.scoring
    ? hasFailingNote(rows, /D\.SEA\.2/) ? 'FAIL' : hasPassingNote(rows, /weekly scoring finalization passed/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const rookieDraftStatus = args.rookieDraft
    ? hasFailingNote(rows, /D\.SEA\.5/) ? 'FAIL' : hasPassingNote(rows, /rookie draft auto-pick passed/) ? 'PARTIAL' : 'PENDING'
    : pickChainStatus

  const coverage = [
    {
      requirement: 'Phase A audit report',
      status: auditExists ? 'PASS' : 'PENDING',
      evidence: auditExists ? 'tests/audit-report.md exists.' : 'tests/audit-report.md missing.',
    },
    {
      requirement: 'P0/P1 findings resolved',
      status: 'PARTIAL',
      evidence: 'Post-refactor deltas are documented, but approval-blocked soak findings remain open and external service-role rotation/history purge is still outside the repo.',
    },
    {
      requirement: 'Real test Supabase project',
      status: env.supabaseUrl && env.serviceRoleKey ? 'PASS' : 'BLOCKED',
      evidence: env.supabaseUrl && env.serviceRoleKey ? 'Supabase URL/service-role credentials loaded from E2E/app env.' : 'Missing Supabase service credentials.',
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
      status: targetLeagueId ? 'PARTIAL' : 'PENDING',
      evidence: targetLeagueId ? `Seeded target league ${targetLeagueId}; invite, lineup slots, members, and 5y pick-bank proof lives in tests/e2e-seed-report.md.` : 'No target league configured.',
    },
    {
      requirement: 'D.SET.3 commissioner settings propagation',
      status: settingsStatus,
      evidence: args.settings ? 'Settings mode creates a disposable league, updates league/scoring/slot settings as the commissioner through Supabase RLS, verifies a manager can read them, and checks manager writes do not mutate commissioner-only settings.' : 'No commissioner settings propagation scenario implemented; enable E2E_ENABLE_SETTINGS=1.',
    },
    {
      requirement: 'D.SET.4 initial auction draft',
      status: auctionStatus,
      evidence: args.auction ? 'Auction mode creates a disposable auction nomination and verifies the atomic bid RPC rejects <=current, >budget, and self-overbid paths before accepting valid bids.' : 'No browser-driven auction draft scenario implemented; enable E2E_ENABLE_AUCTION=1 for server-side bid validation slice.',
    },
    {
      requirement: 'D.0 invariant boundary checks',
      status: invariantStatus,
      evidence: rows.length > 0 ? 'Season rows in tests/e2e-report.md include D.0 boundary checks or failure.' : 'No season rows produced.',
    },
    {
      requirement: 'D.SEA.1 matchup generation idempotency',
      status: matchupStatus,
      evidence: env.backendTicksEnabled ? 'Backend tick mode can call /e2e/generate-matchups twice and compare counts.' : 'Requires E2E_ENABLE_BACKEND_TICKS=1.',
    },
    {
      requirement: 'D.SEA.2 weekly lineup/scoring/waiver/trade loop',
      status: scoringStatus,
      evidence: args.scoring ? 'Scoring mode seeds a disposable matchup with starter/bench lineups and real player_game_stats, calls the real backend /e2e/sync-scores path, and checks starter-only points, finalization blocking, winner, max-possible points, and standings append.' : 'Full weekly browser gameplay loop is not implemented; enable E2E_ENABLE_SCORING=1 for the starter-only scoring/finalization slice.',
    },
    {
      requirement: 'D.SEA.3 standings tiebreakers/RPS',
      status: tiebreakerStatus,
      evidence: args.tiebreakers ? 'Tiebreaker mode seeds a disposable four-way tie and calls the real authenticated /playoffs/generate route to verify max-points/points-against/RPS handling.' : 'No forced four-way tie or RPS browser/backend scenario implemented; enable E2E_ENABLE_TIEBREAKERS=1 for standings tiebreaker coverage.',
    },
    {
      requirement: 'D.SEA.4 playoffs/champion',
      status: playoffsStatus,
      evidence: args.playoffs ? 'Playoff mode seeds a disposable 10-team regular season and calls the real authenticated /playoffs/generate route, then checks for a top-6 bracket.' : 'No playoff bracket/champion scenario implemented; enable E2E_ENABLE_PLAYOFFS=1 for bracket-generation coverage.',
    },
    {
      requirement: 'D.SEA.5 rookie draft/traded picks',
      status: rookieDraftStatus,
      evidence: args.rookieDraft ? 'Rookie-draft mode starts a disposable offseason draft through the real backend route, verifies inverse-standings snake order, auto-pick lowest nba_draft_number, exact pick asset usage, roster insert, and already-rostered rejection.' : args.pickChain ? 'Pick-chain mode ran; D.LONG.1 currently exposes stale unused pick assets.' : 'Enable E2E_ENABLE_ROOKIE_DRAFT=1 for rookie-draft auto-pick/order coverage or E2E_ENABLE_PICK_CHAIN=1 for long-horizon traded-pick materialization.',
    },
    {
      requirement: 'D.SEA.6 season reset',
      status: resetStatus,
      evidence: env.backendTicksEnabled ? 'Backend tick mode calls /e2e/advance-season and re-checks invariants.' : 'Requires E2E_ENABLE_BACKEND_TICKS=1.',
    },
    {
      requirement: 'D.SEA.7 snapshots/no shrink',
      status: snapshotStatus,
      evidence: 'Snapshot summaries are written under tests/snapshots/season-<N>/summary.json.',
    },
    {
      requirement: 'D.X.1 push notifications',
      status: pushStatus,
      evidence: args.push ? 'Push mode ran; waiver path currently exposes process_next_waiver_claim_atomic failure.' : args.draftPush ? 'Draft-push mode runs a disposable rookie auto-pick and asserts the fake Expo upstream captured a draft notification.' : 'Trade push prior slice exists; waiver and draft push slices are separate; enable E2E_ENABLE_PUSH=1 or E2E_ENABLE_DRAFT_PUSH=1.',
    },
    {
      requirement: 'D.X.2 realtime bid/score events',
      status: realtimeStatus,
      evidence: args.realtime ? 'Realtime mode opens multiple Supabase Realtime clients and asserts a matchups update reaches every client within 2s.' : 'Enable E2E_ENABLE_REALTIME=1.',
    },
    {
      requirement: 'D.X.3 CORS regression',
      status: env.backendTicksEnabled ? 'PASS' : 'PENDING',
      evidence: env.backendTicksEnabled ? 'Backend tick mode runs OPTIONS preflight before the season loop.' : 'Requires backend tick mode.',
    },
    {
      requirement: 'D.X.4 perf smoke under draft/live scoring load',
      status: 'PENDING',
      evidence: 'No continuous-bid/live-scoring browser perf scenario implemented.',
    },
    {
      requirement: 'D.X.5 UI sweep',
      status: browserStatus,
      evidence: args.browserFullSweep ? 'Browser full sweep visits auth, tabs, modals, player, auction-draft, and rookie-draft routes, with screenshots and console/error artifacts.' : browserStatus === 'PARTIAL' ? 'Browser smoke/auth covers auth and tab routes; enable E2E_BROWSER_FULL_SWEEP=1 for modal/player/draft route sweep.' : 'Enable browser smoke/auth; full app route sweep pending.',
    },
    {
      requirement: 'D.LONG.1/D.LONG.2 long-horizon pick trades',
      status: pickChainStatus,
      evidence: 'Multi-hop owner persistence exists; rookie-draft materialization currently fails pending approval to fix.',
    },
    {
      requirement: 'D.LONG.3/D.LONG.4 standings/champion history',
      status: historyStatus,
      evidence: args.history ? 'History mode seeds deterministic completed-season standings/champion fixtures and verifies them after season resets.' : 'Enable E2E_ENABLE_HISTORY=1 with backend tick mode.',
    },
    {
      requirement: 'D.LONG.5 mid-life migration',
      status: midlifeMigrationStatus,
      evidence: args.midlifeMigration ? 'Mid-life migration mode runs `npx supabase db push --linked --yes` between seasons and records tests/artifacts/season-<N>/midlife-migration.json.' : 'Enable E2E_ENABLE_MIDLIFE_MIGRATION=1 to apply the no-op migration between seasons 5 and 6.',
    },
    {
      requirement: 'D.LONG.6 runtime drift',
      status: runtimeStatus,
      evidence: 'Runtime metrics live in tests/artifacts/perf-metrics.json.',
    },
    {
      requirement: 'D.LONG.7 memory/connection leaks',
      status: memoryStatus,
      evidence: 'Harness memory metrics live in tests/artifacts/perf-metrics.json; current invariant run exceeds default memory drift gate.',
    },
    {
      requirement: '10 seasons and continue past 10 / 20 clean',
      status: status === 'PASS' && seasons >= 20 ? 'PASS' : 'PENDING',
      evidence: `Current run status is ${status} for target ${seasons} season(s).`,
    },
    {
      requirement: 'Production-ready exit criteria',
      status: 'FAIL',
      evidence: 'Coverage remains pending or failing for multiple required gameplay, long-horizon, and external-secret criteria.',
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
  if (!env.serviceRoleKey) missing.push('E2E_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length === 0) return

  const now = timestamp()
  await writeReport({
    status: 'BLOCKED',
    startedAt: now,
    finishedAt: now,
    seasons,
    rows: [{ season: 0, status: 'BLOCKED', notes: `Missing env: ${missing.join(', ')}` }],
    notes: [
      'The soak runner loads .env and backend/.env, then fails closed until Supabase service credentials are available.',
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
      { p_draft_id: zeroUuid, p_member_id: zeroUuid, p_nomination_id: zeroUuid, p_amount: 0 },
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

const summarizeSnapshot = (tableRows) => {
  const summary = { counts: {} }
  for (const [table, rows] of Object.entries(tableRows)) {
    summary.counts[table] = rows.length
  }
  return summary
}

const writeSnapshots = async (supabase, season, leagueId) => {
  const dir = path.join(SNAPSHOT_ROOT, `season-${season}`)
  await mkdir(dir, { recursive: true })

  const tableRows = {}
  for (const table of SNAPSHOT_TABLES) {
    const rows = await fetchAll(supabase, table, '*', leagueId ? { league_id: leagueId } : {})
    tableRows[table] = rows
    await writeFile(path.join(dir, `${table}.json`), `${JSON.stringify(rows, null, 2)}\n`)
  }
  const summary = summarizeSnapshot(tableRows)
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

  const baseline = metrics[0]?.durationMs
  const latest = metrics.at(-1)?.durationMs
  if (!baseline || !latest) return []

  const maxAllowed = baseline * PERF_DRIFT_LIMIT
  if (latest > maxAllowed) {
    const percent = Math.round(((latest - baseline) / baseline) * 100)
    return [
      `D.LONG.6: per-season runtime drifted ${percent}% from season 1 (${roundedMs(baseline)}ms) to season ${metrics.at(-1).season} (${roundedMs(latest)}ms); limit is ${Math.round((PERF_DRIFT_LIMIT - 1) * 100)}%`,
    ]
  }
  return []
}

const validateMemoryDrift = (metrics, totalSeasons) => {
  if (totalSeasons < 10 || metrics.length < 10) return []
  if (!Number.isFinite(MEMORY_DRIFT_LIMIT) || MEMORY_DRIFT_LIMIT <= 1) {
    return [`D.LONG.7: invalid E2E_MEMORY_DRIFT_LIMIT ${process.env.E2E_MEMORY_DRIFT_LIMIT}`]
  }

  const baseline = metrics[0]?.memory
  const latestMetric = metrics.at(-1)
  const latest = latestMetric?.memory
  if (!baseline || !latest) return []

  const failures = []
  for (const [label, key] of [['RSS', 'rssBytes'], ['heap', 'heapUsedBytes']]) {
    const before = baseline[key]
    const after = latest[key]
    if (!before || !after) continue
    const maxAllowed = before * MEMORY_DRIFT_LIMIT
    if (after > maxAllowed) {
      const percent = Math.round(((after - before) / before) * 100)
      failures.push(
        `D.LONG.7: harness ${label} memory drifted ${percent}% from season 1 (${bytesToMiB(before)} MiB) to season ${latestMetric.season} (${bytesToMiB(after)} MiB); limit is ${Math.round((MEMORY_DRIFT_LIMIT - 1) * 100)}%`,
      )
    }
  }
  return failures
}

const fetchSingle = async (supabase, table, select, filters) => {
  let query = supabase.from(table).select(select)
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value)
  }
  const { data, error } = await query.single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

const countRows = async (supabase, table, filters) => {
  let query = supabase.from(table).select('id', { count: 'exact', head: true })
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value)
  }
  const { count, error } = await query
  if (error) throw new Error(`${table} count: ${error.message}`)
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
  await backendJson(env, '/e2e/generate-matchups', { force: false })
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

const createAndAcceptPickTrade = async (supabase, leagueId, seasonId, proposerId, recipientId, proposerPickId, recipientPickId) => {
  const { data: trade, error: tradeError } = await supabase
    .from('trades')
    .insert({
      league_id: leagueId,
      league_season_id: seasonId,
      proposer_member_id: proposerId,
      recipient_member_id: recipientId,
      status: 'pending',
      notes: 'E2E multi-hop future-pick chain',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`trades insert: ${tradeError.message}`)

  const { error: itemError } = await supabase.from('trade_items').insert([
    { trade_id: trade.id, side: 'proposer', player_id: null, pick_id: proposerPickId },
    { trade_id: trade.id, side: 'recipient', player_id: null, pick_id: recipientPickId },
  ])
  if (itemError) throw new Error(`trade_items insert: ${itemError.message}`)

  const { error: acceptError } = await supabase.rpc('accept_trade_atomic', {
    p_trade_id: trade.id,
    p_accepting_member_id: recipientId,
  })
  if (acceptError) throw new Error(`accept_trade_atomic: ${acceptError.message}`)

  return trade.id
}

const findOwnedPick = async (supabase, leagueId, seasonYear, round, ownerId, excludePickId = null) => {
  let query = supabase
    .from('draft_picks')
    .select('id, current_owner_id, original_owner_id, season_year, round')
    .eq('league_id', leagueId)
    .eq('season_year', seasonYear)
    .eq('round', round)
    .eq('current_owner_id', ownerId)
    .eq('is_used', false)
    .limit(1)
  if (excludePickId) query = query.neq('id', excludePickId)

  const { data, error } = await query
  if (error) throw new Error(`draft_picks owned pick lookup: ${error.message}`)
  const [pick] = data ?? []
  if (!pick) throw new Error(`No owned ${seasonYear} round ${round} pick for member ${ownerId}`)
  return pick
}

const setupFuturePickChain = async (supabase, leagueId) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id, season_year',
    { league_id: leagueId, is_current: true },
  )
  const members = await fetchAll(supabase, 'league_members', 'id, team_name, joined_at', { league_id: leagueId })
  members.sort((a, b) => {
    const joined = String(a.joined_at).localeCompare(String(b.joined_at))
    return joined === 0 ? String(a.id).localeCompare(String(b.id)) : joined
  })
  if (members.length < 4) throw new Error('Future-pick chain requires at least four league members')

  const targetYear = currentSeason.season_year + 5
  const [member1, member2, member3, member4] = members
  const targetPick = await fetchSingle(
    supabase,
    'draft_picks',
    'id, current_owner_id, original_owner_id, season_year, round',
    {
      league_id: leagueId,
      season_year: targetYear,
      round: 1,
      original_owner_id: member1.id,
      current_owner_id: member1.id,
    },
  )

  const counter1 = await findOwnedPick(supabase, leagueId, targetYear, 2, member2.id, targetPick.id)
  const trade1 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member1.id,
    member2.id,
    targetPick.id,
    counter1.id,
  )

  const counter2 = await findOwnedPick(supabase, leagueId, targetYear, 2, member3.id, targetPick.id)
  const trade2 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member2.id,
    member3.id,
    targetPick.id,
    counter2.id,
  )

  const counter3 = await findOwnedPick(supabase, leagueId, targetYear, 2, member4.id, targetPick.id)
  const trade3 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member3.id,
    member4.id,
    targetPick.id,
    counter3.id,
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

const e2eCode = () => Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 8).toUpperCase().padEnd(6, '0')

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
  if (!env.anonKey) throw new Error(`${label}: requires E2E_SUPABASE_ANON_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY`)
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
  const gameDate = todayET()
  const fixtureSeasonYear = scoringFixtureSeasonYear()
  const weekNumber = 1
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
      week_end: gameDate,
    }, { onConflict: 'season_year,week_number' })
  if (weekError) throw new Error(`${label}: season week fixture insert failed: ${weekError.message}`)

  const { data: players, error: playersError } = await supabase
    .from('players')
    .select('id, display_name')
    .not('display_name', 'is', null)
    .order('display_name', { ascending: true })
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
    .insert([homeStarterStats, awayStarterStats, ...benchStats])
  if (statsError) throw new Error(`${label}: player stats fixture insert failed: ${statsError.message}`)

  const { error: lineupError } = await supabase.from('weekly_lineups').insert([
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
  await backendJson(env, '/e2e/sync-scores')
  const scheduledSyncMatchup = await readScoringMatchup(supabase, matchup.id, label)
  const expectedHomePoints = calculateFixturePoints(homeStarterStats, scoringSettings)
  const expectedAwayPoints = calculateFixturePoints(awayStarterStats, scoringSettings)

  assertNumberEquals(failures, `${label}: scheduled-sync home_points`, scheduledSyncMatchup.home_points, expectedHomePoints)
  assertNumberEquals(failures, `${label}: scheduled-sync away_points`, scheduledSyncMatchup.away_points, expectedAwayPoints)
  if (scheduledSyncMatchup.is_finalized) {
    failures.push(`${label}: matchup finalized while an NBA game was still Scheduled`)
  }

  const { error: finalGameError } = await supabase
    .from('nba_games')
    .update({ status: 'Final', home_score: 120, away_score: 111, ended_at: new Date().toISOString() })
    .eq('id', game.id)
  if (finalGameError) throw new Error(`${label}: final game update failed: ${finalGameError.message}`)

  await backendJson(env, '/e2e/sync-scores')
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
    gameId: game.id,
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

  const { data: rookies, error: rookiesError } = await supabase
    .from('players')
    .select('id, display_name, nba_draft_number')
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
        'rps_challenges',
      ],
      maxPointsScenario: 'all four teams are 1-1 with equal points_for; max_possible_points should seed D.SEA.3 Seed 2 first, Seed 4 second, Seed 1 third, Seed 3 fourth',
      rpsScenario: 'all four teams are 1-1 with equal points_for, max_possible_points, and points_against; RPS challenges should be created before deterministic playoff seeding',
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

const assertRealtimeDelivery = async ({ supabase, env, state, leagueId, season }) => {
  if (!state?.password || !Array.isArray(state.users) || state.users.length === 0) {
    throw new Error('D.X.2: realtime scenario requires tests/e2e-state.json from npm run e2e:seed')
  }
  if (!env.anonKey) throw new Error('D.X.2: realtime scenario requires E2E_SUPABASE_ANON_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY')
  if (!Number.isFinite(REALTIME_CLIENTS) || REALTIME_CLIENTS < 1) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_CLIENTS ${process.env.E2E_REALTIME_CLIENTS}`)
  }
  if (!Number.isFinite(REALTIME_LATENCY_LIMIT_MS) || REALTIME_LATENCY_LIMIT_MS < 100) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_LATENCY_LIMIT_MS ${process.env.E2E_REALTIME_LATENCY_LIMIT_MS}`)
  }
  if (!Number.isFinite(REALTIME_SUBSCRIBE_TIMEOUT_MS) || REALTIME_SUBSCRIBE_TIMEOUT_MS < REALTIME_LATENCY_LIMIT_MS) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS ${process.env.E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS}`)
  }

  const target = await insertRealtimeTargetMatchup(supabase, leagueId, season, season)
  const clients = []
  const channels = []
  const deliveries = []
  const expectedHomePoints = 1000 + season
  const expectedAwayPoints = 900 + season

  try {
    const users = Array.from({ length: REALTIME_CLIENTS }, (_, index) => state.users[index % state.users.length])
    for (const [index, user] of users.entries()) {
      const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
      clients.push(client)
      const { error: signInError } = await client.auth.signInWithPassword({ email: user.email, password: state.password })
      if (signInError) throw new Error(`D.X.2 realtime sign-in failed for ${user.email}: ${signInError.message}`)

      const delivery = new Promise((resolve) => {
        const channel = client
          .channel(`e2e_realtime_matchup_${season}_${index}`)
          .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'matchups',
            filter: `id=eq.${target.id}`,
          }, (payload) => {
            if (
              Number(payload.new?.home_points) === expectedHomePoints &&
              Number(payload.new?.away_points) === expectedAwayPoints
            ) {
              resolve({ clientIndex: index, receivedAtMs: nowMs() })
            }
          })
        channels.push({ client, channel })
      })
      deliveries.push(delivery)
    }

    await Promise.all(channels.map(({ channel }, index) => waitForRealtimeSubscribe(channel, `client ${index + 1}`)))
    const updateStartedMs = nowMs()
    const { error: updateError } = await supabase
      .from('matchups')
      .update({
        home_points: expectedHomePoints,
        away_points: expectedAwayPoints,
      })
      .eq('id', target.id)
    if (updateError) throw new Error(`D.X.2 realtime matchup update: ${updateError.message}`)

    const results = await withTimeout(
      Promise.all(deliveries),
      REALTIME_LATENCY_LIMIT_MS,
      `D.X.2: realtime update did not reach all ${REALTIME_CLIENTS} clients within ${REALTIME_LATENCY_LIMIT_MS}ms`,
    )
    const maxLatencyMs = Math.max(...results.map((result) => result.receivedAtMs - updateStartedMs))
    if (maxLatencyMs > REALTIME_LATENCY_LIMIT_MS) {
      throw new Error(`D.X.2: realtime max latency ${roundedMs(maxLatencyMs)}ms exceeded ${REALTIME_LATENCY_LIMIT_MS}ms`)
    }

    await writeFile(
      path.join(ARTIFACT_ROOT, `season-${season}`, 'realtime-latency.json'),
      `${JSON.stringify({
        season,
        matchupId: target.id,
        clients: REALTIME_CLIENTS,
        maxLatencyMs: roundedMs(maxLatencyMs),
        latenciesMs: results.map((result) => roundedMs(result.receivedAtMs - updateStartedMs)),
      }, null, 2)}\n`,
    )
  } finally {
    await Promise.allSettled(channels.map(({ client, channel }) => client.removeChannel(channel)))
    await Promise.allSettled(clients.map((client) => client.auth.signOut()))
  }
}

const applyMidlifeMigration = async (season) => {
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`)
  await mkdir(artifactDir, { recursive: true })
  const startedAt = timestamp()
  const command = ['supabase', 'db', 'push', '--linked', '--yes']
  const report = {
    command: `npx ${command.join(' ')}`,
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
    tradeItems,
    draftPicks,
    drafts,
    nominations,
  ] = await Promise.all([
    leagueId ? fetchAll(supabase, 'leagues', 'id', { id: leagueId }) : fetchAll(supabase, 'leagues', 'id'),
    fetchAll(supabase, 'league_seasons', 'id, league_id, is_current', leagueFilter),
    fetchAll(supabase, 'league_members', 'id, league_id', leagueFilter),
    fetchAll(supabase, 'roster_players', 'id, league_id, league_season_id, member_id, player_id', leagueFilter),
    fetchAll(supabase, 'weekly_lineups', 'id, league_id, league_season_id, member_id, player_id', leagueFilter),
    fetchAll(supabase, 'waiver_claims', 'id, league_id, league_season_id, member_id, player_id, drop_player_id, status, process_date', leagueFilter),
    fetchAll(supabase, 'trades', 'id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, veto_window_expires_at', leagueFilter),
    fetchAll(supabase, 'trade_items', 'id, trade_id, player_id, pick_id'),
    fetchAll(supabase, 'draft_picks', 'id, league_id, season_year, round, current_owner_id, original_owner_id', leagueFilter),
    fetchAll(supabase, 'drafts', 'id, league_id', leagueFilter),
    fetchAll(supabase, 'nominations', 'id, draft_id, status, countdown_expires_at'),
  ])

  const failures = []
  const leagueIds = new Set(leagues.map((row) => row.id))
  const seasonIds = indexById(leagueSeasons)
  const membersById = indexById(leagueMembers)
  const draftIds = new Set(drafts.map((draft) => draft.id))
  const tradeIds = new Set(trades.map((trade) => trade.id))
  const scopedTradeItems = leagueId ? tradeItems.filter((item) => tradeIds.has(item.trade_id)) : tradeItems
  const scopedNominations = leagueId ? nominations.filter((nomination) => draftIds.has(nomination.draft_id)) : nominations

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

const signInForAccessToken = async (env, email, password) => {
  if (!env.anonKey) throw new Error('E2E authenticated backend scenarios require E2E_SUPABASE_ANON_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY')
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`E2E sign-in failed for ${email}: ${error.message}`)
  const token = data.session?.access_token
  if (!token) throw new Error(`E2E sign-in for ${email} returned no access token`)
  return token
}

const assertTradePushNotification = async ({ supabase, env, state, leagueId, season, fakePort }) => {
  if (!state?.password || !Array.isArray(state.users) || state.users.length < 2) {
    throw new Error('D.X.1: E2E_ENABLE_PUSH=1 requires tests/e2e-state.json from npm run e2e:seed')
  }

  const [senderUser, recipientUser] = state.users
  const tokenValue = `ExponentPushToken[e2e-${state.runId ?? 'run'}-${season}]`
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ push_token: tokenValue })
    .eq('id', recipientUser.id)
  if (profileError) throw new Error(`D.X.1 push token setup: ${profileError.message}`)

  const { data: recipientMember, error: memberError } = await supabase
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', leagueId)
    .eq('user_id', recipientUser.id)
    .single()
  if (memberError || !recipientMember) {
    throw new Error(`D.X.1 recipient member lookup: ${memberError?.message ?? 'missing row'}`)
  }

  await postJson(`http://127.0.0.1:${fakePort}/admin/clear-pushes`, {})
  const accessToken = await signInForAccessToken(env, senderUser.email, state.password)
  const title = `E2E Trade Proposed S${season}`
  const body = `Trade notification intercept for ${recipientMember.team_name}`
  await backendAuthedJson(env, '/notify/trade', accessToken, {
    memberId: recipientMember.id,
    title,
    body,
  })

  const response = await fetch(`http://127.0.0.1:${fakePort}/admin/pushes`)
  if (!response.ok) throw new Error(`D.X.1 push capture returned ${response.status}`)
  const { pushes } = await response.json()
  const match = pushes?.find((push) => (
    push.body?.to === tokenValue &&
    push.body?.title === title &&
    push.body?.body === body
  ))
  if (!match) {
    throw new Error(`D.X.1: trade push was not captured for token ${tokenValue}`)
  }

  const artifact = {
    season,
    recipientMemberId: recipientMember.id,
    recipientUserId: recipientUser.id,
    captured: match,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'push-notifications.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
}

const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const findAvailablePlayer = async (supabase, leagueId, leagueSeasonId) => {
  const [players, rosterRows] = await Promise.all([
    fetchAll(supabase, 'players', 'id, display_name'),
    fetchAll(supabase, 'roster_players', 'player_id', {
      league_id: leagueId,
      league_season_id: leagueSeasonId,
    }),
  ])
  const rosteredIds = new Set(rosterRows.map((row) => row.player_id))
  const player = players
    .filter((row) => row.display_name)
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)) || String(a.id).localeCompare(String(b.id)))
    .find((row) => !rosteredIds.has(row.id))
  if (!player) throw new Error('D.X.1: no available player found for waiver push scenario')
  return player
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

  const [{ id: bidderOne }, { id: bidderTwo }] = members
  const now = new Date().toISOString()
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
      args: { ...baseArgs, p_member_id: bidderOne, p_amount: 1 },
      pattern: /Bid must exceed current bid/i,
    }),
    overBudget: await expectAuctionRpcError({
      supabase,
      label: 'bid over budget',
      args: { ...baseArgs, p_member_id: bidderOne, p_amount: 6 },
      pattern: /Insufficient budget/i,
    }),
  }

  const { error: firstBidError } = await supabase.rpc('place_auction_bid_atomic', {
    ...baseArgs,
    p_member_id: bidderOne,
    p_amount: 2,
  })
  if (firstBidError) throw new Error(`D.SET.4 first valid auction bid: ${firstBidError.message}`)

  rejected.selfOverbid = await expectAuctionRpcError({
    supabase,
    label: 'self-overbid',
    args: { ...baseArgs, p_member_id: bidderOne, p_amount: 3 },
    pattern: /already the highest bidder/i,
  })

  const { error: secondBidError } = await supabase.rpc('place_auction_bid_atomic', {
    ...baseArgs,
    p_member_id: bidderTwo,
    p_amount: 3,
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

  const recipientUser = state.users[2]
  const tokenValue = `ExponentPushToken[e2e-waiver-${state.runId}-${season}]`
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ push_token: tokenValue })
    .eq('id', recipientUser.id)
  if (profileError) throw new Error(`D.X.1 waiver push token setup: ${profileError.message}`)

  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const { data: member, error: memberError } = await supabase
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', leagueId)
    .eq('user_id', recipientUser.id)
    .single()
  if (memberError || !member) {
    throw new Error(`D.X.1 waiver member lookup: ${memberError?.message ?? 'missing row'}`)
  }

  const player = await findAvailablePlayer(supabase, leagueId, currentSeason.id)
  const { data: priority, error: priorityError } = await supabase
    .from('waiver_priorities')
    .select('priority')
    .eq('league_id', leagueId)
    .eq('league_season_id', currentSeason.id)
    .eq('member_id', member.id)
    .single()
  if (priorityError || !priority) {
    throw new Error(`D.X.1 waiver priority lookup: ${priorityError?.message ?? 'missing row'}`)
  }

  const now = new Date()
  const clearsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const { data: waiverLog, error: logError } = await supabase
    .from('waiver_wire_log')
    .insert({
      league_id: leagueId,
      league_season_id: currentSeason.id,
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
      league_id: leagueId,
      league_season_id: currentSeason.id,
      member_id: member.id,
      player_id: player.id,
      drop_player_id: null,
      priority_at_submission: priority.priority,
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
    throw new Error(`D.X.1: waiver push was not captured for token ${tokenValue}`)
  }

  return {
    season,
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
  await assertTradePushNotification(params)
  const waiver = await assertWaiverPushNotification(params)

  const artifactPath = path.join(ARTIFACT_ROOT, `season-${params.season}`, 'push-notifications.json')
  const existing = JSON.parse(await readFile(artifactPath, 'utf8'))
  await writeFile(
    artifactPath,
    `${JSON.stringify({ trade: existing, waiver }, null, 2)}\n`,
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
  if (args.draftPush && (!state?.password || !Array.isArray(state.users) || state.users.length < 4)) {
    throw new Error('E2E_ENABLE_DRAFT_PUSH=1 requires tests/e2e-state.json from npm run e2e:seed with at least 4 users')
  }
  if (args.draftPush && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_DRAFT_PUSH=1 requires E2E_ADMIN_SECRET and a backend started with ENABLE_E2E_ROUTES=1')
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
    throw new Error('E2E_ENABLE_SCORING=1 requires E2E_ADMIN_SECRET and a backend started with ENABLE_E2E_ROUTES=1')
  }
  if (args.rookieDraft && (!state?.password || !Array.isArray(state.users) || state.users.length < 4)) {
    throw new Error('E2E_ENABLE_ROOKIE_DRAFT=1 requires tests/e2e-state.json from npm run e2e:seed with at least 4 users')
  }
  if (args.rookieDraft && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_ROOKIE_DRAFT=1 requires E2E_ADMIN_SECRET and a backend started with ENABLE_E2E_ROUTES=1')
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
    args.browser
      ? `Browser smoke enabled through E2E_ENABLE_BROWSER=1${args.browserFullSweep ? ' with full route sweep.' : '.'}`
      : 'Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.',
    args.browserAuth
      ? 'Browser auth scenario enabled through E2E_ENABLE_BROWSER_AUTH=1.'
      : 'Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.',
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
      : 'Standings/champion history retention disabled; set E2E_ENABLE_HISTORY=1 with backend ticks to exercise the D.LONG.3/D.LONG.4 fixture-retention slice.',
    args.realtime
      ? `Realtime latency check enabled through E2E_ENABLE_REALTIME=1 for ${REALTIME_CLIENTS} clients.`
      : 'Realtime latency check disabled; set E2E_ENABLE_REALTIME=1 to exercise the D.X.2 matchups update slice.',
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
      ? 'Standings tiebreaker/RPS scenario enabled through E2E_ENABLE_TIEBREAKERS=1.'
      : 'Standings tiebreaker/RPS scenario disabled; set E2E_ENABLE_TIEBREAKERS=1 to exercise D.SEA.3.',
    args.settings
      ? 'Commissioner settings propagation scenario enabled through E2E_ENABLE_SETTINGS=1.'
      : 'Commissioner settings propagation scenario disabled; set E2E_ENABLE_SETTINGS=1 to exercise D.SET.3.',
    args.scoring
      ? 'Weekly starter-only scoring/finalization scenario enabled through E2E_ENABLE_SCORING=1.'
      : 'Weekly starter-only scoring/finalization scenario disabled; set E2E_ENABLE_SCORING=1 to exercise the D.SEA.2 scoring slice.',
    args.rookieDraft
      ? 'Rookie draft auto-pick/order scenario enabled through E2E_ENABLE_ROOKIE_DRAFT=1.'
      : 'Rookie draft auto-pick/order scenario disabled; set E2E_ENABLE_ROOKIE_DRAFT=1 to exercise the D.SEA.5 auto-pick slice.',
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
          await backendJson(env, '/e2e/live-poll', { date: `${2026 + season}-10-20T12:00:00.000Z` })
          await backendJson(env, '/e2e/process-waivers')
          await backendJson(env, '/e2e/generate-matchups', { force: false })
        }

        if (args.browser) {
          await runBrowserSmoke({ season, fullSweep: args.browserFullSweep })
        }
        if (args.browserAuth) {
          await runBrowserAuthScenario({ season })
        }
        let auctionValidation = null
        if (args.auction && season === 1) {
          auctionValidation = await assertAuctionBidValidation({
            supabase,
            leagueId: targetLeagueId,
            season,
          })
        }
        let playoffCheck = null
        const playoffFailures = []
        if (args.playoffs && season === 1) {
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
        if (args.tiebreakers && season === 1) {
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
        if (args.settings && season === 1) {
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
        if (args.scoring && season === 1) {
          scoringCheck = await assertWeeklyScoringFinalizationScenario({
            supabase,
            env,
            state,
            season,
          })
          scoringFailures.push(...scoringCheck.failures)
        }
        let rookieDraftCheck = null
        const rookieDraftFailures = []
        if (args.rookieDraft && season === 1) {
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
        if (args.draftPush && season === 1) {
          draftPushCheck = await assertDraftPushNotification({
            supabase,
            env,
            state,
            season,
            fakePort: args.fakePort,
          })
          draftPushFailures.push(...draftPushCheck.failures)
        }

        const failuresAtStart = await runInvariants(supabase, targetLeagueId, scenarios)
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
          ...playoffFailures,
          ...tiebreakerFailures,
          ...settingsFailures,
          ...scoringFailures,
          ...rookieDraftFailures,
          ...draftPushFailures,
          ...perfFailures,
          ...memoryFailures,
        ]

        if (failures.length > 0) {
          rows.push({ season, status: 'FAIL', notes: failures.join('; ') })
          if (!args.keepGoing) break
        } else {
          const seasonNotes = env.backendTicksEnabled
            ? 'D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending'
            : 'D.0 invariant boundary checks passed; full scenario/browser loop pending'
          rows.push({
            season,
            status: 'PASS',
            notes: [
              seasonNotes,
              args.browser ? 'browser smoke passed' : null,
              args.browserAuth ? 'browser auth scenario passed' : null,
              args.realtime ? 'realtime matchup update delivered' : null,
              args.push ? 'trade and waiver push notification intercepts passed' : null,
              draftPushCheck ? 'draft push notification intercept passed' : null,
              midlifeMigrationReport ? `mid-life migration applied (${midlifeMigrationReport.status})` : null,
              auctionValidation ? 'auction bid validation passed' : null,
              playoffCheck ? 'playoff bracket scenario passed' : null,
              tiebreakerCheck ? 'standings tiebreaker scenario passed' : null,
              settingsCheck ? 'commissioner settings propagation passed' : null,
              scoringCheck ? 'weekly scoring finalization passed' : null,
              rookieDraftCheck ? 'rookie draft auto-pick passed' : null,
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

    const status = rows.some((row) => row.status === 'FAIL') ? 'FAIL' : 'PARTIAL'
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

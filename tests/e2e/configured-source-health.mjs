import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { evaluateConfiguredSourceHealth } from './configured-source-health-contract.mjs'
import { querySupabaseDb, writeMarkdownReport } from './env.mjs'

const outputArg = process.argv.find((arg) => arg.startsWith('--output-dir='))
const outputDir = path.resolve(outputArg?.slice('--output-dir='.length) ?? 'tests/source-health')
const recoveryVerified = process.env.E2E_SOURCE_RECOVERY_VERIFIED === '1'
const now = new Date()
const offseason = [7, 8, 9].includes(now.getUTCMonth() + 1)

const runRows = querySupabaseDb('local', 'configured source runs', `
  SELECT function_name, status, started_at, finished_at, rows_affected, error
    FROM public.sync_runs
   WHERE function_name IN (
     'sync-schedule', 'source:nba-cdn-scoreboard', 'sync-stats',
     'sync-players', 'sync-rankings', 'sync-draft-order'
   )
   ORDER BY started_at DESC
`)

const projectionRows = querySupabaseDb('local', 'FantasyPros source runs', `
  SELECT DISTINCT ON (projection_type)
         projection_type, status, started_at, completed_at, row_count,
         matched_count, unmatched_count, error_message
    FROM public.projection_sync_runs
   WHERE source = 'fantasypros'
   ORDER BY projection_type, started_at DESC
`)

const [metrics] = querySupabaseDb('local', 'configured source completeness', `
  WITH published_season AS (
    SELECT season_year
      FROM public.nba_games
     WHERE season_year BETWEEN 2020 AND 2035
       AND nba_game_id ~ '^[0-9]{10}$'
     GROUP BY season_year
     ORDER BY count(*) DESC, season_year DESC
     LIMIT 1
  ),
  official_games AS (
    SELECT g.*
      FROM public.nba_games g, published_season s
     WHERE g.season_year = s.season_year
       AND g.nba_game_id ~ '^[0-9]{10}$'
  ),
  official_finals AS (
    SELECT id FROM official_games WHERE status = 'Final'
  )
  SELECT
    (SELECT season_year FROM published_season) AS schedule_season_year,
    (SELECT count(*) FROM official_games) AS schedule_games,
    (SELECT count(*) FROM public.season_weeks w, published_season s WHERE w.season_year = s.season_year) AS schedule_weeks,
    (SELECT count(*) FROM official_finals) AS final_games,
    (SELECT count(*) FROM official_finals f WHERE NOT EXISTS (
      SELECT 1 FROM public.player_game_stats pgs WHERE pgs.game_id = f.id
    )) AS final_games_without_stats,
    (SELECT count(*) FROM public.players WHERE nba_id IS NOT NULL) AS nba_ids,
    (SELECT count(*) FROM public.players WHERE espn_id IS NOT NULL) AS espn_ids,
    (SELECT count(*) FROM public.dynasty_news WHERE source = 'espn') AS espn_news,
    (SELECT max(published_at) FROM public.dynasty_news WHERE source = 'espn') AS latest_espn_news,
    (SELECT count(*) FROM public.dynasty_rankings WHERE source = 'hashtagbasketball.com') AS hashtag_rows,
    (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE source = 'hashtagbasketball.com') AS latest_hashtag_fetch,
    (SELECT count(*) FROM public.players WHERE years_exp = 0 AND nba_draft_number IS NOT NULL) AS numbered_rookies
`)

const latestRun = (name) => runRows.find((row) => row.function_name === name)
const priorFailureBefore = (name, successAt) => runRows.some((row) =>
  row.function_name === name && row.status === 'failed' &&
  new Date(String(row.started_at)) < new Date(String(successAt)),
)
const ageHours = (value) => Math.round(((now.getTime() - new Date(String(value)).getTime()) / 3_600_000) * 10) / 10
const dimension = (status, evidence) => ({ status, evidence })
const successRun = (name, maxAgeHours) => {
  const run = latestRun(name)
  if (!run) return dimension('fail', `No ${name} attempt exists.`)
  const age = ageHours(run.finished_at ?? run.started_at)
  return dimension(
    run.status === 'success' && age <= maxAgeHours ? 'pass' : 'fail',
    `${name} latest=${run.status}, age=${age}h, rows=${run.rows_affected ?? 'n/a'}.`,
  )
}
const latestRunsHealthy = (names) => names.every((name) => latestRun(name)?.status === 'success')
const recoveryGate = (evidence) => dimension(
  recoveryVerified ? 'pass' : 'fail',
  recoveryVerified ? evidence : 'Recovery tests were not confirmed for this report run.',
)

const nbaRunNames = ['sync-schedule', 'source:nba-cdn-scoreboard', 'sync-stats', 'sync-players']
const nbaFreshnessParts = nbaRunNames.map((name) => successRun(name, 48))
const nbaFreshness = dimension(
  nbaFreshnessParts.every((part) => part.status === 'pass') ? 'pass' : 'fail',
  nbaFreshnessParts.map((part) => part.evidence).join(' '),
)
const nbaComplete = Number(metrics.schedule_games) >= 1000 && Number(metrics.schedule_weeks) >= 20 &&
  Number(metrics.final_games_without_stats) === 0 && Number(metrics.nba_ids) >= 500

const espnRun = latestRun('sync-players')
const espnNewsAge = metrics.latest_espn_news ? ageHours(metrics.latest_espn_news) : Number.POSITIVE_INFINITY
const fantasyAttemptsFresh = projectionRows.length === 3 && projectionRows.every((row) => ageHours(row.started_at) <= 48)
const fantasyStatusesExpected = projectionRows.every((row) =>
  row.status === 'success' || (offseason && row.status === 'skipped'),
)
const rankingRun = latestRun('sync-rankings')
const draftRun = latestRun('sync-draft-order')

const observations = [
  {
    id: 'nba-cdn',
    freshness: nbaFreshness,
    completeness: dimension(
      nbaComplete ? 'pass' : 'fail',
      `season=${metrics.schedule_season_year}, games=${metrics.schedule_games}, weeks=${metrics.schedule_weeks}, ` +
        `finals_missing_stats=${metrics.final_games_without_stats}/${metrics.final_games}, nba_ids=${metrics.nba_ids}.`,
    ),
    failures: dimension(
      latestRunsHealthy(nbaRunNames) ? 'pass' : 'fail',
      `Latest schedule, scoreboard, box-score, and player-index attempts are ${latestRunsHealthy(nbaRunNames) ? 'successful' : 'not all successful'}.`,
    ),
    recovery: recoveryGate('Down, non-JSON, reshaped, and next-good NBA CDN requests pass the degraded-source suite.'),
  },
  {
    id: 'espn-public-json',
    freshness: successRun('sync-players', 48),
    completeness: dimension(
      Number(metrics.espn_ids) >= 500 && Number(metrics.espn_news) > 0 && espnNewsAge <= 14 * 24 ? 'pass' : 'fail',
      `espn_ids=${metrics.espn_ids}, news=${metrics.espn_news}, latest_news_age=${espnNewsAge}h.`,
    ),
    failures: dimension(
      espnRun?.status === 'success' ? 'pass' : 'fail',
      `Latest player, team, position, injury, and news attempt is ${espnRun?.status ?? 'missing'}; errors are retained in sync_runs.`,
    ),
    recovery: dimension(
      recoveryVerified && espnRun && priorFailureBefore('sync-players', espnRun.started_at) ? 'pass' : 'fail',
      recoveryVerified && espnRun && priorFailureBefore('sync-players', espnRun.started_at)
        ? 'A live 403 failure was recorded, the endpoint changed, and the next local run succeeded.'
        : 'No confirmed failed-then-successful local run exists.',
    ),
  },
  {
    id: 'fantasypros',
    freshness: dimension(
      fantasyAttemptsFresh ? 'pass' : 'fail',
      `${projectionRows.length}/3 projection types attempted within 48h.`,
    ),
    completeness: dimension(
      fantasyStatusesExpected ? (offseason && projectionRows.every((row) => row.status === 'skipped') ? 'expected-unavailable' : 'pass') : 'fail',
      projectionRows.map((row) => `${row.projection_type}=${row.status}:${row.row_count} rows`).join(', ') || 'No attempts.',
    ),
    failures: dimension(
      fantasyStatusesExpected ? 'pass' : 'fail',
      projectionRows.map((row) => `${row.projection_type}: ${row.error_message ?? 'no error'}`).join(' | ') || 'No attempts.',
    ),
    recovery: recoveryGate('Unavailable and changed markup return zero rows; a saved valid response parses on the next attempt.'),
  },
  {
    id: 'hashtag-basketball',
    freshness: successRun('sync-rankings', 8 * 24),
    completeness: dimension(
      Number(metrics.hashtag_rows) >= 300 ? 'pass' : 'fail',
      `latest points view has ${metrics.hashtag_rows} rows; fetched_at=${metrics.latest_hashtag_fetch}.`,
    ),
    failures: dimension(
      rankingRun?.status === 'success' ? 'pass' : 'fail',
      `Latest ranking attempt is ${rankingRun?.status ?? 'missing'}; row floors and selected-view checks fail closed.`,
    ),
    recovery: recoveryGate('Changed markup returns zero rows; the saved valid response parses after the degraded case.'),
  },
  {
    id: 'nba-draft-order',
    freshness: successRun('sync-draft-order', 400 * 24),
    completeness: dimension(
      Number(metrics.numbered_rookies) >= 50 ? 'pass' : 'fail',
      `${metrics.numbered_rookies} rookies have a verified draft number.`,
    ),
    failures: dimension(
      draftRun?.status === 'success' ? 'pass' : 'fail',
      `Latest draft attempt is ${draftRun?.status ?? 'missing'}; incomplete boards preserve prior data.`,
    ),
    recovery: recoveryGate('A failed window day preserves prior data; the next valid day writes and verifies all picks.'),
  },
  {
    id: 'sleeper-fallback',
    disabledReason: 'PLAYER_SYNC_SOURCE defaults to ESPN. Sleeper remains a dormant opt-in fallback.',
    freshness: dimension('disabled', 'No request is expected while the fallback flag is off.'),
    completeness: dimension('disabled', 'Dormant data does not count toward the active player-source floor.'),
    failures: dimension('disabled', 'No silent request can occur while the source is disabled.'),
    recovery: dimension('disabled', 'Recovery requires an intentional source switch after licensing review.'),
  },
]

const evaluation = evaluateConfiguredSourceHealth(observations)
const rows = observations.map((source) => ({
  requirement: source.id,
  status: evaluation.failures.some((failure) => failure.startsWith(`${source.id}:`) || failure === `missing source: ${source.id}`)
    ? 'BLOCKED'
    : 'PASS',
  freshness: `${source.freshness.status}: ${source.freshness.evidence}`,
  completeness: `${source.completeness.status}: ${source.completeness.evidence}`,
  failures: `${source.failures.status}: ${source.failures.evidence}`,
  recovery: `${source.recovery.status}: ${source.recovery.evidence}`,
}))

await mkdir(outputDir, { recursive: true })
await writeMarkdownReport({
  reportPath: path.join(outputDir, 'source-health.md'),
  title: 'Configured Game Source Health',
  rows,
  columns: [
    { header: 'Source', value: (row) => row.requirement },
    { header: 'Status', value: (row) => row.status },
    { header: 'Freshness', value: (row) => row.freshness },
    { header: 'Completeness', value: (row) => row.completeness },
    { header: 'Failures', value: (row) => row.failures },
    { header: 'Recovery', value: (row) => row.recovery },
  ],
})
await writeFile(path.join(outputDir, 'source-health.json'), `${JSON.stringify({
  generatedAt: now.toISOString(),
  scope: 'local database and public read-only sources',
  recoveryTestsConfirmed: recoveryVerified,
  pass: evaluation.pass,
  failures: evaluation.failures,
  observations,
}, null, 2)}\n`)

console.log(`${evaluation.pass ? 'PASS' : 'BLOCKED'} ${path.join(outputDir, 'source-health.json')}`)
if (!evaluation.pass) process.exitCode = 1

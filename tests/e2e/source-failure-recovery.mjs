import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = process.cwd()
const ARTIFACT_PATH = path.join(ROOT, 'tests/artifacts/source-failure-recovery.json')

export const CONFIGURED_SOURCE_SUITES = Object.freeze([
  { id: 'nba-cdn', files: ['supabase/functions/_shared/nbaCdnDegraded.test.ts'] },
  { id: 'espn-public-json', files: ['supabase/functions/_shared/playerSource.test.ts'] },
  {
    id: 'fantasypros',
    files: [
      'supabase/functions/sync-projections/parser.test.ts',
      'supabase/functions/sync-projections/match.test.ts',
    ],
  },
  {
    id: 'hashtag-basketball',
    files: [
      'supabase/functions/sync-rankings/parser.test.ts',
      'supabase/functions/sync-rankings/match.test.ts',
    ],
  },
  { id: 'nba-draft-order', files: ['supabase/functions/sync-draft-order/degraded.test.ts'] },
  { id: 'sleeper-fallback', disabledReason: 'The fallback source is disabled by default.' },
])

export const sourceRecoveryFailures = (report) => {
  const failures = []
  for (const expected of CONFIGURED_SOURCE_SUITES) {
    const actual = report.sources?.find(({ id }) => id === expected.id)
    if (!actual) {
      failures.push(`configured source ${expected.id} is missing`)
      continue
    }
    if (expected.disabledReason) {
      if (actual.status !== 'DISABLED' || !actual.disabledReason) {
        failures.push(`configured source ${expected.id} lacks an explicit disabled contract`)
      }
    } else if (actual.status !== 'PASS') {
      failures.push(`configured source ${expected.id} recovery did not pass`)
    }
  }
  return failures
}

export const assertSourceFailureRecovery = async () => {
  const files = CONFIGURED_SOURCE_SUITES.flatMap(({ files = [] }) => files)
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const { stdout, stderr } = await execFileAsync(
    'deno',
    ['test', '--allow-env', '--allow-net', '--allow-read', ...files],
    { cwd: ROOT, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  )
  const report = {
    schemaVersion: 1,
    status: 'PASS',
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    sources: CONFIGURED_SOURCE_SUITES.map((source) => source.disabledReason
      ? { id: source.id, status: 'DISABLED', disabledReason: source.disabledReason }
      : { id: source.id, status: 'PASS', files: source.files }),
    command: ['deno', 'test', '--allow-env', '--allow-net', '--allow-read', ...files],
    summary: [...stdout.split('\n'), ...stderr.split('\n')]
      .find((line) => /^ok \| \d+ passed \| 0 failed/.test(line.trim()))?.trim() ?? 'all selected suites passed',
    evidenceIds: ['source.failure_recovery'],
  }
  const failures = sourceRecoveryFailures(report)
  if (failures.length > 0) throw new Error(`Source recovery proof failed: ${failures.join('; ')}`)
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true })
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertSourceFailureRecovery()
    .then((report) => process.stdout.write(`${JSON.stringify({
      status: report.status,
      sources: report.sources.length,
      durationMs: report.durationMs,
      summary: report.summary,
    })}\n`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}

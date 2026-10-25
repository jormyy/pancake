import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSoakShard } from './soak-shards.mjs'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'
import { REQUIRED_MUTATION_SCENARIOS } from './release-mutation-compatibility.mjs'
import { BROWSER_SCENARIO_MANIFEST } from './browser-scenario-manifest.mjs'
import { validateAppliedMigrationDelta } from './release-soak-migration-plan.mjs'

export const soakRuntimeForSeason = (season, deployedSeasons) => season <= deployedSeasons ? 'deployed' : 'release'

export const soakRuntimeForShard = (shard, deployedSeasons) => {
  if (!Number.isInteger(deployedSeasons) || deployedSeasons < 1 ||
      soakRuntimeForSeason(shard.firstSeason, deployedSeasons) !== soakRuntimeForSeason(shard.lastSeason, deployedSeasons)) {
    throw new Error('A soak shard must stay entirely before or after the migration boundary')
  }
  return soakRuntimeForSeason(shard.firstSeason, deployedSeasons)
}

export const soakRuntimeSchemaFailures = ({ runtime, appliedVersion, deployedVersion, repositoryHead }) => {
  if (!['deployed', 'release'].includes(runtime)) return ['Soak runtime must be deployed or release']
  const expected = runtime === 'deployed' ? deployedVersion : repositoryHead
  return expected && appliedVersion === expected ? [] : [`${runtime} runtime requires schema ${expected}; found ${appliedVersion}`]
}

export const soakBrowserArgs = (args, season, deployedSeasons) => {
  if (soakRuntimeForSeason(season, deployedSeasons) === 'release') return args
  const allowed = new Set(REQUIRED_MUTATION_SCENARIOS)
  return { ...args, ...Object.fromEntries(BROWSER_SCENARIO_MANIFEST.map(({ id, flag }) => [flag, Boolean(args[flag]) && allowed.has(id)])) }
}

export const preparedMigrationFailures = (report, { deployedVersion, repositoryHead, pendingVersions }) => {
  const failures = validateAppliedMigrationDelta({
    beforeVersions: report.beforeVersions ?? [], afterVersions: report.afterVersions ?? [], expectedVersions: pendingVersions,
  }).failures
  if (report.expectedBaseVersion !== deployedVersion || report.beforeVersions?.at(-1) !== deployedVersion ||
      report.expectedVersion !== repositoryHead || report.afterVersions?.at(-1) !== repositoryHead ||
      JSON.stringify(report.expectedVersions) !== JSON.stringify(pendingVersions) ||
      report.status !== (pendingVersions.length ? 'APPLIED' : 'CURRENT')) {
    failures.push('Prepared mid-life migration evidence does not match the attested plan')
  }
  return failures
}

export const readPreparedMigration = (season) => {
  const report = JSON.parse(readFileSync(`tests/artifacts/season-${season}/midlife-migration.json`, 'utf8'))
  const failures = preparedMigrationFailures(report, {
    deployedVersion: process.env.E2E_MIDLIFE_EXPECTED_BASE_VERSION,
    repositoryHead: process.env.E2E_MIDLIFE_EXPECTED_VERSION,
    pendingVersions: JSON.parse(process.env.E2E_MIDLIFE_EXPECTED_VERSIONS ?? '[]'),
  })
  if (failures.length) throw new Error(failures.join('; '))
  return report
}

const main = async () => {
  if (!process.argv.includes('--prepare')) throw new Error('--prepare is required')
  const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts['e2e:soak:release']
  const seasons = Number(script.match(/--seasons=(\d+)/)?.[1])
  const shard = resolveSoakShard(process.env.E2E_SOAK_SHARD, seasons)
  const deployedSeasons = Number(process.env.E2E_MIDLIFE_MIGRATION_AFTER_SEASON ?? 5)
  const runtime = soakRuntimeForShard(shard, deployedSeasons)
  const target = databaseTarget()
  if (runtime === 'release' && shard.firstSeason === deployedSeasons + 1) {
    const { applyMidlifeMigration } = await import('./soak-realtime-invariants.mjs')
    await applyMidlifeMigration(shard.firstSeason)
  }
  const appliedVersion = execFileSync('psql', [target.href, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
    'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1'], { encoding: 'utf8', timeout: 30000 }).trim()
  const failures = soakRuntimeSchemaFailures({ runtime, appliedVersion,
    deployedVersion: process.env.E2E_DEPLOYED_SCHEMA_VERSION, repositoryHead: process.env.SOAK_REPOSITORY_HEAD })
  if (failures.length) throw new Error(failures.join('; '))
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `E2E_SOAK_RUNTIME=${runtime}\nE2E_SOAK_DEPLOYED_SEASONS=${deployedSeasons}\n`)
  }
  process.stdout.write(runtime)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

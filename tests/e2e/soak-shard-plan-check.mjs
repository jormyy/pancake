import process from 'node:process'
import { planReleaseMigrations } from './release-soak-migration-plan.mjs'

// Each soak shard receives the plan attested against production once. It re-derives the
// repository side from its own checkout so every shard runs the same pending range.
export const soakShardPlanFailures = ({ filenames, deployedVersion, pendingFiles, pendingVersions, repositoryHead }) => {
  let plan
  try {
    plan = planReleaseMigrations(filenames, deployedVersion)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  const failures = []
  if (JSON.stringify(plan.pendingFiles) !== JSON.stringify(pendingFiles)) failures.push('pending migration files differ from the attested plan')
  if (JSON.stringify(plan.pendingVersions) !== JSON.stringify(pendingVersions)) failures.push('pending migration versions differ from the attested plan')
  if (plan.repositoryHead !== repositoryHead) failures.push('repository migration head differs from the attested plan')
  return failures
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const parse = (name) => {
    try {
      return JSON.parse(process.env[name] ?? '')
    } catch {
      return null
    }
  }
  const failures = soakShardPlanFailures({
    filenames: process.argv.slice(2),
    deployedVersion: process.env.E2E_DEPLOYED_SCHEMA_VERSION ?? '',
    pendingFiles: parse('SOAK_PENDING_FILES'),
    pendingVersions: parse('SOAK_PENDING_VERSIONS'),
    repositoryHead: process.env.SOAK_REPOSITORY_HEAD ?? '',
  })
  if (failures.length > 0) {
    console.error(`Soak shard plan check failed: ${failures.join('; ')}`)
    process.exitCode = 1
  }
}

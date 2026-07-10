import process from 'node:process'

const migration = (filename) => {
  const match = filename.match(/^(\d+)_.*\.sql$/)
  if (!match) throw new Error(`Invalid migration filename: ${filename}`)
  return { filename, version: match[1] }
}

export const planReleaseMigrations = (filenames, deployedVersion) => {
  if (!/^\d+$/.test(deployedVersion)) throw new Error('Deployed schema version must be numeric')
  const migrations = filenames.map(migration).toSorted((left, right) => left.version.localeCompare(right.version))
  if (migrations.length === 0) throw new Error('Repository contains no migrations')
  const versions = migrations.map(({ version }) => version)
  if (new Set(versions).size !== versions.length) throw new Error('Repository contains duplicate migration versions')
  const repositoryHead = versions.at(-1)
  if (deployedVersion > repositoryHead) throw new Error(`Deployed schema ${deployedVersion} is ahead of repository head ${repositoryHead}`)
  if (!versions.includes(deployedVersion)) throw new Error(`Deployed schema ${deployedVersion} is not present in the repository`)
  const pending = migrations.filter(({ version }) => version > deployedVersion)
  return {
    deployedVersion,
    repositoryHead,
    pendingFiles: pending.map(({ filename }) => filename),
    pendingVersions: pending.map(({ version }) => version),
  }
}

export const validateAppliedMigrationDelta = ({ beforeVersions, afterVersions, expectedVersions }) => {
  const appliedVersions = afterVersions.filter((version) => !beforeVersions.includes(version))
  const failures = []
  if (JSON.stringify(appliedVersions) !== JSON.stringify(expectedVersions)) {
    failures.push(`applied migration delta ${appliedVersions.join(',') || '<empty>'} did not match expected ${expectedVersions.join(',') || '<empty>'}`)
  }
  const expectedAfter = [...beforeVersions, ...expectedVersions]
  if (JSON.stringify(afterVersions) !== JSON.stringify(expectedAfter)) {
    failures.push('post-migration schema history was not the exact ordered deployed-to-HEAD history')
  }
  return { appliedVersions, failures }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(JSON.stringify(planReleaseMigrations(process.argv.slice(3), process.argv[2] ?? '')))
}

import process from 'node:process'
import { readFileSync } from 'node:fs'

const migration = (filename) => {
  const match = filename.match(/^(\d+)_.*\.sql$/)
  if (!match) throw new Error(`Invalid migration filename: ${filename}`)
  return { filename, version: match[1], name: filename.slice(match[1].length + 1, -4) }
}

const repositoryMigrations = (filenames) => {
  const migrations = filenames.map(migration).toSorted((left, right) => left.version.localeCompare(right.version))
  if (migrations.length === 0) throw new Error('Repository contains no migrations')
  const versions = migrations.map(({ version }) => version)
  if (new Set(versions).size !== versions.length) throw new Error('Repository contains duplicate migration versions')
  return migrations
}

export const planReleaseMigrations = (filenames, deployedVersion) => {
  if (!/^\d+$/.test(deployedVersion)) throw new Error('Deployed schema version must be numeric')
  const migrations = repositoryMigrations(filenames)
  const versions = migrations.map(({ version }) => version)
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

export const planReleaseMigrationsFromHistory = (filenames, deployedRows) => {
  const migrations = repositoryMigrations(filenames)
  if (!Array.isArray(deployedRows) || deployedRows.length === 0) {
    throw new Error('Production migration history is empty or unavailable')
  }
  const seen = new Set()
  const applied = deployedRows.map((row, index) => {
    const version = row?.version
    const name = row?.name
    if (typeof version !== 'string' || !/^\d+$/.test(version) || typeof name !== 'string' || name.length === 0) {
      throw new Error(`Production migration history row ${index + 1} is malformed`)
    }
    if (seen.has(version)) throw new Error(`Production migration history contains duplicate version ${version}`)
    seen.add(version)
    return { version, name }
  })
  if (applied.length > migrations.length) {
    throw new Error('Production migration history contains versions not present in the repository')
  }
  for (const [index, row] of applied.entries()) {
    const expected = migrations[index]
    if (row.version !== expected.version || row.name !== expected.name) {
      throw new Error(
        `Production migration history diverges at row ${index + 1}: ` +
        `${row.version}_${row.name} != ${expected.version}_${expected.name}`,
      )
    }
  }
  const plan = planReleaseMigrations(filenames, applied.at(-1).version)
  return { ...plan, deployedHistory: applied }
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
  if (process.argv[2] === '--history-file') {
    const payload = JSON.parse(readFileSync(process.argv[3], 'utf8'))
    process.stdout.write(JSON.stringify(planReleaseMigrationsFromHistory(process.argv.slice(4), payload?.rows)))
  } else {
    process.stdout.write(JSON.stringify(planReleaseMigrations(process.argv.slice(3), process.argv[2] ?? '')))
  }
}

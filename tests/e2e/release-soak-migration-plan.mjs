import process from 'node:process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const attestations = JSON.parse(readFileSync(new URL('./release-history-attestations.json', import.meta.url), 'utf8'))

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

// The generic planner above stays strict. Only this production entry point
// accepts the audited aliases, with both recorded SQL and live convergence.
export const planAttestedProductionMigrations = (repositoryFiles, snapshot, projectRef) => {
  if (projectRef !== attestations.projectRef) throw new Error('Unattested production project')
  if (!Array.isArray(snapshot?.history) || !Array.isArray(snapshot?.functions)) {
    throw new Error('Production history attestation is missing')
  }
  const { history } = snapshot
  const approved = attestations.approvedMigrations
  const files = repositoryFiles.toSorted((left, right) => left.filename.localeCompare(right.filename))
  if (files.length !== attestations.baselineCount + approved.length ||
      history.length < attestations.baselineCount || history.length > files.length) {
    throw new Error('Production history is outside the audited migration range')
  }
  for (const [index, expected] of approved.entries()) {
    const file = files[attestations.baselineCount + index]
    if (file.filename !== `${expected.version}_${expected.name}.sql` || file.sha256 !== expected.sha256) {
      throw new Error('Unexpected production migration range or SQL')
    }
  }
  if (migration(files[attestations.baselineCount - 1].filename).version !== attestations.baselineVersion) {
    throw new Error('Unexpected production migration baseline')
  }

  const aliases = new Map(attestations.aliases.map((entry) => [entry.version, entry]))
  const canonicalRows = history.map((row, index) => {
    const alias = aliases.get(row?.version)
    if (!alias) return row
    const file = files[index]
    if (row.name !== alias.deployedName || row.statementCount !== alias.statementCount ||
        row.statementsSha256 !== alias.statementsSha256 ||
        file.filename !== `${alias.version}_${alias.repositoryName}.sql` ||
        file.sha256 !== alias.repositorySha256) {
      throw new Error(`Production migration attestation failed at row ${index + 1}`)
    }
    return { version: row.version, name: alias.repositoryName }
  })
  const plan = planReleaseMigrationsFromHistory(files.map(({ filename }) => filename), canonicalRows)
  // The complete deployed prefix must contain every audited alias exactly once.
  if (history.filter((row) => aliases.has(row.version)).length !== aliases.size) {
    throw new Error('Production history omits an audited alias')
  }
  if (snapshot.oldHelperCount !== 0 || snapshot.oldHelperReferenceCount !== 0 ||
      snapshot.functions.length !== attestations.convergence.length) {
    throw new Error('Production helper convergence is incomplete')
  }
  for (const [index, expected] of attestations.convergence.entries()) {
    const actual = snapshot.functions[index]
    if (Object.entries(expected).some(([key, value]) => JSON.stringify(actual?.[key]) !== JSON.stringify(value))) {
      throw new Error(`Production helper convergence failed at function ${index + 1}`)
    }
  }
  return {
    ...plan,
    // Preserve actual recorded labels in evidence; canonicalization is comparison-only.
    deployedHistory: history.map(({ version, name }) => ({ version, name })),
    attestedAliases: attestations.aliases.map(({ version, difference }) => ({ version, difference })),
    projectRef,
  }
}

export const readProductionHistorySnapshot = (payload) => {
  // Supabase CLI versions emit either an array or a { rows } envelope.
  const rows = Array.isArray(payload) ? payload : payload?.rows
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]?.snapshot) {
    throw new Error('Production history query must return one attestation snapshot')
  }
  return rows[0].snapshot
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
    if (process.argv[4] !== '--project-ref') throw new Error('Production project ref is required')
    const files = process.argv.slice(6).map((filename) => {
      if (path.basename(filename) !== filename) throw new Error('Migration filename must not contain a path')
      return {
        filename,
        sha256: createHash('sha256').update(readFileSync(path.join('supabase/migrations', filename))).digest('hex'),
      }
    })
    process.stdout.write(JSON.stringify(planAttestedProductionMigrations(
      files, readProductionHistorySnapshot(payload), process.argv[5],
    )))
  } else {
    process.stdout.write(JSON.stringify(planReleaseMigrations(process.argv.slice(3), process.argv[2] ?? '')))
  }
}

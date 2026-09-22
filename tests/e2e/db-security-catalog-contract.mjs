import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { planAttestedProductionMigrations, planReleaseMigrationsFromHistory } from './release-soak-migration-plan.mjs'

const release = JSON.parse(readFileSync(new URL('./release-history-attestations.json', import.meta.url), 'utf8'))
const catalogContract = JSON.parse(readFileSync(new URL('./db-security-catalog-attestations.json', import.meta.url), 'utf8'))
const phases = ['pre-migration', 'post-migration']

export const parseCatalogOptions = (args) => {
  const phaseArgs = args.filter((arg) => arg.startsWith('--phase='))
  const targets = args.filter((arg) => ['--local', '--linked'].includes(arg))
  if (phaseArgs.length !== 1 || !phases.includes(phaseArgs[0].slice(8))) {
    throw new Error('Exactly one --phase=pre-migration or --phase=post-migration is required')
  }
  if (targets.length > 1 || args.filter((arg) => arg === '--catalog-only').length > 1 ||
      args.some((arg) => ![...phaseArgs, ...targets, '--catalog-only'].includes(arg))) {
    throw new Error('Unknown or duplicate catalog option')
  }
  return {
    phase: phaseArgs[0].slice(8),
    targets: [targets[0] === '--linked' ? 'linked' : 'local'],
    catalogOnly: args.includes('--catalog-only'),
  }
}

export const validateCatalogTarget = ({ target, linkedRef, projectRef }) => {
  if (target === 'linked') {
    if (projectRef !== release.projectRef || linkedRef !== release.projectRef) {
      throw new Error('Catalog target must match the attested production project and linked ref')
    }
  } else if (target !== 'local' || linkedRef) {
    throw new Error('Local catalog verification requires an unlinked local project')
  }
}

const functionKey = (row) => `${row.schema}.${row.name}(${row.identityArguments})`
const validateObjects = (section, actual, expected) => {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new Error(`Catalog ${section}: missing or unexpected objects`)
  }
  const key = section === 'functions' ? functionKey : (row) => row.name
  const seen = new Set()
  for (const row of actual) {
    if (!row || typeof row !== 'object') throw new Error(`Catalog ${section}: malformed object`)
    const id = key(row)
    if (seen.has(id)) throw new Error(`Catalog ${section}: duplicate object ${id}`)
    seen.add(id)
    const wanted = expected.find((item) => key(item) === id)
    if (!wanted || !isDeepStrictEqual(row, wanted)) {
      throw new Error(`Catalog ${section}: unrecognized or changed object ${id}`)
    }
  }
}

export const validateSecurityCatalog = ({ phase, target, projectRef, repositoryFiles, history, catalog }) => {
  if (!phases.includes(phase)) throw new Error('Unknown database catalog phase')
  if (!['local', 'linked'].includes(target)) throw new Error('Unknown database catalog target')
  if (catalogContract.version !== 1 || catalogContract.baselineVersion !== release.baselineVersion ||
      catalogContract.candidateVersion !== release.approvedMigrations.at(-1).version) {
    throw new Error('Catalog and migration attestations disagree')
  }
  for (const expected of catalogContract.sourceMigrations) {
    if (repositoryFiles.find((row) => row.filename === expected.filename)?.sha256 !== expected.sha256) {
      throw new Error(`Catalog source migration changed: ${expected.filename}`)
    }
  }
  const plan = target === 'linked'
    ? planAttestedProductionMigrations(repositoryFiles, history, projectRef)
    : planReleaseMigrationsFromHistory(repositoryFiles.map((file) => file.filename), history?.history)
  const expectedCount = release.baselineCount + (phase === 'post-migration' ? release.approvedMigrations.length : 0)
  const expectedVersion = phase === 'pre-migration' ? catalogContract.baselineVersion : catalogContract.candidateVersion
  if (repositoryFiles.length !== release.baselineCount + release.approvedMigrations.length ||
      plan.deployedHistory.length !== expectedCount || plan.deployedVersion !== expectedVersion ||
      plan.repositoryHead !== catalogContract.candidateVersion ||
      !isDeepStrictEqual(plan.pendingVersions, phase === 'pre-migration' ? release.approvedMigrations.map((row) => row.version) : [])) {
    throw new Error(`Migration history does not match the exact ${phase} contract`)
  }
  // Local histories use canonical names; the production planner separately
  // validates the audited historical aliases and their stored SQL fingerprints.
  for (const expected of release.approvedMigrations) {
    const file = repositoryFiles.find((row) => row.filename === `${expected.version}_${expected.name}.sql`)
    if (file?.sha256 !== expected.sha256) throw new Error('Approved migration source changed')
    const applied = history.history.find((row) => row.version === expected.version)
    if (applied && (applied.statementCount !== expected.statementCount || applied.statementsSha256 !== expected.statementsSha256)) {
      throw new Error(`Applied migration SQL changed: ${expected.version}`)
    }
  }
  if (catalog?.replicationRole !== 'origin' || catalog?.serviceRoleMissingReads !== 0) {
    throw new Error('Catalog requires origin triggers and service-role read access')
  }
  for (const section of ['functions', 'triggers', 'policies', 'tables', 'indexes']) {
    validateObjects(section, catalog[section], [...catalogContract.common[section], ...catalogContract.phases[phase][section]])
  }
  return { phase, migrationCount: expectedCount, migrationVersion: expectedVersion,
    functions: catalog.functions.length, triggers: catalog.triggers.length,
    policies: catalog.policies.length, tables: catalog.tables.length, indexes: catalog.indexes.length }
}

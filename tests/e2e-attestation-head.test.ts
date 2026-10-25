import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import { attestationRangeFailures, migrationSqlFingerprint, regenerateAttestation, regenerateSecurityCatalog } from '../scripts/regenerate-release-history-attestations.mjs'

const attestation = JSON.parse(readFileSync('tests/e2e/release-history-attestations.json', 'utf8'))
const files = readdirSync('supabase/migrations').filter((file) => /^\d+_.+\.sql$/.test(file)).sort().map((filename) => {
  const sql = readFileSync(`supabase/migrations/${filename}`, 'utf8')
  return { filename, sql, sha256: createHash('sha256').update(sql).digest('hex') }
})

it('attests every migration through the repository head', () => {
  expect(attestation.approvedMigrations.at(-1).version).toBe(files.at(-1)!.filename.split('_')[0])
  expect(attestation.baselineCount + attestation.approvedMigrations.length).toBe(files.length)
  expect(attestationRangeFailures(attestation, files)).toEqual([])
})

it('rejects unapproved suffixes and changed SQL even when the count matches', () => {
  const short = { ...attestation, approvedMigrations: attestation.approvedMigrations.slice(0, -1) }
  expect(attestationRangeFailures(short, files)).toContain('Attested migration range must end at the repository migration head')
  const altered = files.map((row, index) => index === files.length - 1 ? { ...row, sha256: '0'.repeat(64) } : row)
  expect(attestationRangeFailures(attestation, altered)).toContain(`Attested migration SQL differs at ${attestation.approvedMigrations.at(-1).version}`)
})

it('refuses refreshes from incomplete local migration history', () => {
  expect(() => regenerateAttestation(attestation, files, { history: [] })).toThrow('every repository migration')
})

it('refuses approvals when a migration changes after the local stack applies it', () => {
  const fixture = { baselineCount: 1, baselineVersion: '100', approvedMigrations: [], convergence: [], convergenceRedefinitions: [] }
  const files = [
    { filename: '100_base.sql', sql: 'SELECT 1;', sha256: '1'.repeat(64) },
    { filename: '200_changed.sql', sql: "SELECT 'new';", sha256: '2'.repeat(64) },
  ]
  const snapshot = { history: [
    { version: '100', name: 'base', statements: ['SELECT 1'] },
    { version: '200', name: 'changed', statementCount: 1, statementsSha256: '3'.repeat(64), statements: ["SELECT 'old'"] },
  ], functions: [], oldHelperCount: 0, oldHelperReferenceCount: 0 }
  expect(() => regenerateAttestation(fixture, files, snapshot)).toThrow('Local migration SQL differs')
})

it('compares stored SQL without hiding changes inside strings or function bodies', () => {
  expect(migrationSqlFingerprint("-- heading\nSELECT /* outer /* nested */ */ 'a b';"))
    .toBe(migrationSqlFingerprint("SELECT 'a b'"))
  expect(migrationSqlFingerprint("SELECT 'a b'")).not.toBe(migrationSqlFingerprint("SELECT 'ab'"))
  expect(migrationSqlFingerprint('SELECT $$a b$$')).not.toBe(migrationSqlFingerprint('SELECT $$ab$$'))
  expect(migrationSqlFingerprint('SELECT a b')).not.toBe(migrationSqlFingerprint('SELECT ab'))
})

it('refreshes the release catalog while preserving the recorded production phase', () => {
  const contract = JSON.parse(readFileSync('tests/e2e/db-security-catalog-attestations.json', 'utf8'))
  const catalog = { replicationRole: 'origin', serviceRoleMissingReads: 0,
    ...Object.fromEntries(Object.keys(contract.common).map((section) => [section,
      [...contract.common[section], ...contract.phases['post-migration'][section]]])),
  }
  const next = regenerateSecurityCatalog(contract, files, catalog)
  expect(next.preMigration).toEqual(contract.preMigration)
  expect(next.candidateVersion).toBe(files.at(-1)!.filename.split('_')[0])
  for (const section of Object.keys(contract.common)) {
    expect([...next.common[section], ...next.phases['pre-migration'][section]])
      .toEqual([...contract.common[section], ...contract.phases['pre-migration'][section]])
  }
})

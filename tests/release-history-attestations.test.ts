import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  planAttestedProductionMigrations,
  readProductionHistorySnapshot,
} from './e2e/release-soak-migration-plan.mjs'

const attestation = JSON.parse(readFileSync('tests/e2e/release-history-attestations.json', 'utf8'))
const aliasVersions: string[] = attestation.aliases.map((alias: { version: string }) => alias.version)
const files = readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort().map((filename) => ({
  filename,
  sha256: createHash('sha256').update(readFileSync(path.join('supabase/migrations', filename))).digest('hex'),
}))
const fixture = (applied = 0) => ({
  history: files.slice(0, attestation.baselineCount + applied).map(({ filename }) => {
    const version = filename.split('_')[0]
    const name = filename.slice(version.length + 1, -4)
    const alias = attestation.aliases.find((entry: { version: string }) => entry.version === version)
    const fingerprint = alias ?? attestation.approvedMigrations.find((entry: { version: string }) => entry.version === version)
    return {
      version,
      name: alias?.deployedName ?? name,
      statementCount: fingerprint?.statementCount ?? 0,
      statementsSha256: fingerprint?.statementsSha256 ?? '',
    }
  }),
  functions: structuredClone(attestation.convergence),
  oldHelperCount: 0,
  oldHelperReferenceCount: 0,
})

describe('attested production migration history', () => {
  it.each([0, 1, 2, 3, 4, 5])('plans only the approved suffix after %i applied migrations', (applied) => {
    const snapshot = fixture(applied)
    const before = structuredClone(snapshot)
    const result = planAttestedProductionMigrations(files, snapshot, attestation.projectRef)
    expect(result.pendingFiles).toEqual(files.slice(attestation.baselineCount + applied).map((file) => file.filename))
    expect(result.attestedAliases).toHaveLength(24)
    expect(result.attestedAliases.filter((alias: { difference: string }) => alias.difference === 'label-only')).toHaveLength(21)
    expect(result.attestedAliases.filter((alias: { difference: string }) => alias.difference === 'temporary-helper-identifiers'))
      .toEqual(['20260627000011', '20260627000017', '20260627000025'].map((version) => ({
        version, difference: 'temporary-helper-identifiers',
      })))
    expect(snapshot).toEqual(before)
    expect(result.deployedHistory).toEqual(before.history.map(({ version, name }) => ({ version, name })))
  })

  it.each(aliasVersions)(
    'rejects changed stored SQL for audited migration %s', (version) => {
      const snapshot = fixture()
      const row = snapshot.history.find((entry) => entry.version === version)!
      row.statementsSha256 = '0'.repeat(64)
      expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('attestation failed')
    },
  )

  it('rejects an unaudited baseline even when repository and history agree', () => {
    const changed = structuredClone(files)
    const snapshot = fixture()
    const index = attestation.baselineCount - 1
    changed[index].filename = changed[index].filename.replace(attestation.baselineVersion, '20260828000003')
    snapshot.history[index].version = '20260828000003'
    expect(() => planAttestedProductionMigrations(changed, snapshot, attestation.projectRef))
      .toThrow('Unexpected production migration baseline')
  })

  it.each([0, 1, 2, 3, 4])('rejects altered or absent stored SQL for approved migration %i', (index) => {
    for (const field of ['statementCount', 'statementsSha256'] as const) {
      for (const value of [undefined, field === 'statementCount' ? -1 : '0'.repeat(64)]) {
        const snapshot = fixture(index + 1)
        snapshot.history[attestation.baselineCount + index][field] = value
        expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef))
          .toThrow(`Approved production migration attestation failed at row ${attestation.baselineCount + index + 1}`)
      }
    }
  })

  it.each(['', 'anotherproject', undefined])('rejects an unbound target %s', (projectRef) => {
    expect(() => planAttestedProductionMigrations(files, fixture(), projectRef)).toThrow('Unattested production project')
  })

  it('rejects a missing snapshot or function collection', () => {
    for (const snapshot of [undefined, { history: fixture().history }]) {
      expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('attestation is missing')
    }
  })

  it('rejects unknown names, even when their SQL hash matches an audited row', () => {
    const snapshot = fixture()
    const row = snapshot.history.find((entry) => entry.version === attestation.aliases[0].version)!
    row.name = 'unknown_alias'
    expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('attestation failed')
    row.name = attestation.aliases[0].repositoryName
    expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('attestation failed')
    const other = fixture()
    other.history[0].name = 'unknown_alias'
    expect(() => planAttestedProductionMigrations(files, other, attestation.projectRef)).toThrow('diverges at row 1')
  })

  it('rejects missing SQL fingerprints and changed statement counts', () => {
    for (const field of ['statementCount', 'statementsSha256'] as const) {
      const snapshot = fixture()
      const row = snapshot.history.find((entry) => entry.version === attestation.aliases[0].version)!
      row[field] = undefined
      expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('attestation failed')
    }
    const snapshot = fixture()
    snapshot.history.find((entry) => entry.version === attestation.aliases[0].version)!.statementCount++
    expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('attestation failed')
  })

  it('rejects changed historical repository SQL', () => {
    const changed = structuredClone(files)
    changed.find((file) => file.filename.startsWith(attestation.aliases[0].version))!.sha256 = 'f'.repeat(64)
    expect(() => planAttestedProductionMigrations(changed, fixture(), attestation.projectRef)).toThrow('attestation failed')
  })

  it('rejects missing, duplicate, reordered and foreign deployed versions', () => {
    const missing = fixture()
    missing.history.splice(1, 1)
    const duplicate = fixture()
    duplicate.history[1] = { ...duplicate.history[0] }
    const reordered = fixture()
    ;[reordered.history[0], reordered.history[1]] = [reordered.history[1], reordered.history[0]]
    const foreign = fixture()
    foreign.history[1].version = '19000101000000'
    for (const [snapshot, message] of [
      [missing, 'Production history is outside the audited migration range'],
      [duplicate, `Production migration history contains duplicate version ${duplicate.history[0].version}`],
      [reordered, 'Production migration history diverges at row 1'],
      [foreign, 'Production migration history diverges at row 2'],
    ] as const) {
      expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow(message)
    }
  })

  it('rejects an extra pending migration and changed approved migration SQL', () => {
    const extra = [...files, { filename: '20260922000001_unreviewed.sql', sha256: 'a'.repeat(64) }]
    expect(() => planAttestedProductionMigrations(extra, fixture(), attestation.projectRef)).toThrow('audited migration range')
    for (let index = attestation.baselineCount; index < files.length; index++) {
      const changed = structuredClone(files)
      changed[index].sha256 = 'f'.repeat(64)
      expect(() => planAttestedProductionMigrations(changed, fixture(), attestation.projectRef)).toThrow('Unexpected production migration range or SQL')
    }
  })

  it('rejects deployed history longer than the repository through the strict planner', () => {
    const snapshot = fixture(5)
    snapshot.history.push({ version: '20260922000001', name: 'foreign', statementCount: 0, statementsSha256: '' })
    expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef))
      .toThrow('Production migration history contains versions not present in the repository')
  })

  it('rejects changed helper bodies, signatures, settings and effective grants', () => {
    for (const field of Object.keys(attestation.convergence[0])) {
      const snapshot = fixture()
      snapshot.functions[0][field] = null
      expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('convergence failed')
    }
    for (let index = 0; index < attestation.convergence.length; index++) {
      const snapshot = fixture()
      snapshot.functions[index].bodySha256 = 'f'.repeat(64)
      expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('convergence failed')
    }
  })

  it('rejects absent convergence, old helper objects and stale helper calls', () => {
    const missing = fixture()
    missing.functions.pop()
    const oldName = { ...fixture(), oldHelperCount: 1 }
    const oldCall = { ...fixture(), oldHelperReferenceCount: 1 }
    const absent = { ...fixture(), oldHelperCount: undefined }
    for (const snapshot of [missing, oldName, oldCall, absent]) {
      expect(() => planAttestedProductionMigrations(files, snapshot, attestation.projectRef)).toThrow('convergence is incomplete')
    }
  })

  it('accepts both CLI envelopes but rejects legacy, empty and ambiguous snapshots', () => {
    const snapshot = fixture()
    expect(readProductionHistorySnapshot([{ snapshot }])).toEqual(snapshot)
    expect(readProductionHistorySnapshot({ rows: [{ snapshot }] })).toEqual(snapshot)
    for (const payload of [null, {}, [], { rows: [] }, { rows: fixture().history }, [{ snapshot }, { snapshot }]]) {
      expect(() => readProductionHistorySnapshot(payload)).toThrow('one attestation snapshot')
    }
  })

  it('executes the workflow target guard before collecting its attestation input', () => {
    const workflow = readFileSync('.github/workflows/release-soak.yml', 'utf8')
    const queryBlock = workflow.match(/test "\$\(cat supabase\/\.temp\/project-ref\)"[\s\S]*?> \/tmp\/deployed-schema-history.json/)?.[0]
    expect(queryBlock).toBeTruthy()
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pancake-history-'))
    try {
      mkdirSync(path.join(dir, 'supabase/.temp'), { recursive: true })
      writeFileSync(path.join(dir, 'input.json'), JSON.stringify([{ snapshot: fixture() }]))
      // A local CLI double records whether the protected workflow reaches its query.
      writeFileSync(path.join(dir, 'supabase-cli'), '#!/bin/sh\n: > queried\ncat input.json\n')
      chmodSync(path.join(dir, 'supabase-cli'), 0o700)
      const script = `set -e\n${queryBlock!.replace('supabase db query', './supabase-cli db query')
        .replace('/tmp/deployed-schema-history.json', 'output.json')}`
      const env = { ...process.env, SUPABASE_PROJECT_REF: attestation.projectRef }
      writeFileSync(path.join(dir, 'supabase/.temp/project-ref'), 'wrong-project')
      expect(() => execFileSync('bash', ['-c', script], { cwd: dir, env, stdio: 'pipe' })).toThrow()
      expect(existsSync(path.join(dir, 'queried'))).toBe(false)
      writeFileSync(path.join(dir, 'supabase/.temp/project-ref'), attestation.projectRef)
      execFileSync('bash', ['-c', script], { cwd: dir, env, stdio: 'pipe' })
      const snapshot = readProductionHistorySnapshot(JSON.parse(readFileSync(path.join(dir, 'output.json'), 'utf8')))
      expect(planAttestedProductionMigrations(files, snapshot, attestation.projectRef).pendingVersions)
        .toEqual(attestation.approvedMigrations.map((entry: { version: string }) => entry.version))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

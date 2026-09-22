import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { parseCatalogOptions, validateCatalogTarget, validateSecurityCatalog } from './e2e/db-security-catalog-contract.mjs'

const release = JSON.parse(readFileSync('tests/e2e/release-history-attestations.json', 'utf8'))
const contract = JSON.parse(readFileSync('tests/e2e/db-security-catalog-attestations.json', 'utf8'))
const files = readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort().map((filename) => ({
  filename, sha256: createHash('sha256').update(readFileSync(`supabase/migrations/${filename}`)).digest('hex'),
}))
type Phase = 'pre-migration' | 'post-migration'
const fixture = (phase: Phase) => {
  const history = files.slice(0, release.baselineCount + (phase === 'post-migration' ? release.approvedMigrations.length : 0))
    .map(({ filename }) => {
      const version = filename.split('_')[0]
      const alias = release.aliases.find((row: { version: string }) => row.version === version)
      const fingerprint = alias ?? release.approvedMigrations.find((row: { version: string }) => row.version === version)
      return { version, name: alias?.deployedName ?? filename.slice(version.length + 1, -4),
        statementCount: fingerprint?.statementCount ?? 0, statementsSha256: fingerprint?.statementsSha256 ?? '' }
    })
  const section = (name: string) => structuredClone([...contract.common[name], ...contract.phases[phase][name]])
  const catalog = { replicationRole: 'origin', serviceRoleMissingReads: 0,
    functions: section('functions'), triggers: section('triggers'), policies: section('policies'),
    tables: section('tables'), indexes: section('indexes') }
  return { phase, target: 'linked', projectRef: release.projectRef, repositoryFiles: structuredClone(files),
    history: { history, functions: structuredClone(release.convergence), oldHelperCount: 0, oldHelperReferenceCount: 0 }, catalog }
}

it.each(['pre-migration', 'post-migration'] as const)('accepts the exact %s schema, including its cron contract', (phase) => {
  const input = fixture(phase)
  const result = validateSecurityCatalog(input)
  expect(result.migrationCount).toBe(phase === 'pre-migration' ? 320 : 325)
  const cron = input.catalog.functions.find((row: { name: string }) => row.name === 'invoke_edge_function_at_et_time')
  expect(cron.identityArguments.includes('p_now')).toBe(phase === 'post-migration')
  expect(cron.anonExecute).toBe(false)
  expect(cron.authenticatedExecute).toBe(false)
  expect(cron.serviceRoleExecute).toBe(true)
})

it.each([
  ['pre-migration', 'post-migration'], ['post-migration', 'pre-migration'],
] as const)('rejects a %s request on the %s database', (requested, actual) => {
  expect(() => validateSecurityCatalog({ ...fixture(actual), phase: requested })).toThrow(`exact ${requested} contract`)
})

it.each(['pre-migration', 'post-migration'] as const)('requires every existing %s function, not just a migration marker', (phase) => {
  const input = fixture(phase)
  input.catalog.functions = input.catalog.functions.filter((row: { name: string }) => row.name !== 'invoke_edge_function_at_et_time')
  expect(() => validateSecurityCatalog(input)).toThrow('Catalog functions: missing or unexpected objects')
})

it('rejects a partial approved upgrade in either phase', () => {
  for (const phase of ['pre-migration', 'post-migration'] as const) {
    const input = fixture('post-migration')
    input.phase = phase
    input.history.history.splice(322)
    expect(() => validateSecurityCatalog(input)).toThrow(`exact ${phase} contract`)
  }
})

it('rejects source drift in the baseline guard chain', () => {
  const input = fixture('pre-migration')
  const filename = contract.sourceMigrations.find((row: { filename: string }) => row.filename.startsWith('202608')).filename
  input.repositoryFiles.find((row) => row.filename === filename)!.sha256 = '0'.repeat(64)
  expect(() => validateSecurityCatalog(input)).toThrow(`Catalog source migration changed: ${filename}`)
})

it('binds every attested function body to pinned migration SQL', () => {
  const bodies = new Set<string>()
  for (const source of contract.sourceMigrations) {
    const sql = readFileSync(`supabase/migrations/${source.filename}`, 'utf8')
    expect(createHash('sha256').update(sql).digest('hex')).toBe(source.sha256)
    for (const match of sql.matchAll(/\$(\w*)\$([\s\S]*?)\$\1\$/g)) {
      bodies.add(createHash('sha256').update(match[2]).digest('hex'))
    }
  }
  for (const group of [contract.common, ...Object.values(contract.phases)] as { functions: { bodySha256: string }[] }[]) {
    for (const fn of group.functions) expect(bodies.has(fn.bodySha256), fn.bodySha256).toBe(true)
  }
})

it.each([
  ['unknown target', (x: ReturnType<typeof fixture>) => { x.projectRef = 'wrong-project' }, 'Unattested production project'],
  ['changed SQL of an applied migration', (x: ReturnType<typeof fixture>) => { x.history.history[320].statementsSha256 = '0'.repeat(64) }, 'Approved production migration attestation failed'],
  ['changed migration file', (x: ReturnType<typeof fixture>) => { x.repositoryFiles[320].sha256 = '0'.repeat(64) }, 'Unexpected production migration range or SQL'],
  ['unknown alias', (x: ReturnType<typeof fixture>) => { x.history.history[0].name = 'unreviewed' }, 'Production migration history diverges'],
  ['reordered history', (x: ReturnType<typeof fixture>) => { x.history.history.reverse() }, 'Production migration attestation failed'],
  ['missing history row', (x: ReturnType<typeof fixture>) => { x.history.history.splice(3, 1) }, 'Production migration attestation failed'],
] as const)('rejects %s', (_name, mutate, error) => {
  const input = fixture('post-migration')
  mutate(input)
  expect(() => validateSecurityCatalog(input)).toThrow(error)
})

it.each([
  ['missing lineup helper', (x: ReturnType<typeof fixture>) => { x.catalog.functions = x.catalog.functions.filter((r: { name: string }) => r.name !== 'lineup_game_started') }, 'Catalog functions: missing'],
  ['changed started-game predicate', (x: ReturnType<typeof fixture>) => { x.catalog.functions.find((r: { name: string }) => r.name === 'lineup_game_started').bodySha256 = createHash('sha256').update('SELECT false').digest('hex') }, 'Catalog functions: unrecognized or changed object private.lineup_game_started'],
  ['removed trigger delegation', (x: ReturnType<typeof fixture>) => { x.catalog.functions.find((r: { name: string }) => r.name === 'sync_roster_linked_state').bodySha256 = '0'.repeat(64) }, 'Catalog functions: unrecognized or changed object private.sync_roster_linked_state'],
  ['changed helper search path', (x: ReturnType<typeof fixture>) => { x.catalog.functions.find((r: { name: string }) => r.name === 'clear_future_unlocked_lineups').config = ['search_path=public, unsafe'] }, 'Catalog functions: unrecognized or changed object private.clear_future_unlocked_lineups'],
  ['cron grant to anon', (x: ReturnType<typeof fixture>) => { x.catalog.functions.find((r: { name: string }) => r.name === 'invoke_edge_function_at_et_time').anonExecute = true }, 'Catalog functions: unrecognized or changed object public.invoke_edge_function_at_et_time'],
  ['unknown overload', (x: ReturnType<typeof fixture>) => { x.catalog.functions.push({ ...x.catalog.functions[0], identityArguments: 'unexpected text' }) }, 'Catalog functions: missing or unexpected'],
  ['disabled lifecycle trigger', (x: ReturnType<typeof fixture>) => { x.catalog.triggers.find((r: { name: string }) => r.name === 'sync_roster_linked_state').enabled = 'D' }, 'Catalog triggers: unrecognized or changed object sync_roster_linked_state'],
  ['replica-only lifecycle trigger', (x: ReturnType<typeof fixture>) => { x.catalog.triggers.find((r: { name: string }) => r.name === 'sync_roster_linked_state').enabled = 'R' }, 'Catalog triggers: unrecognized or changed object sync_roster_linked_state'],
  ['conditional lifecycle trigger', (x: ReturnType<typeof fixture>) => { x.catalog.triggers.find((r: { name: string }) => r.name === 'sync_roster_linked_state').definition += ' WHEN (false)' }, 'Catalog triggers: unrecognized or changed object sync_roster_linked_state'],
  ['wrong trigger function', (x: ReturnType<typeof fixture>) => { x.catalog.triggers.find((r: { name: string }) => r.name === 'sync_roster_linked_state').functionName = 'noop' }, 'Catalog triggers: unrecognized or changed object sync_roster_linked_state'],
  ['replica session', (x: ReturnType<typeof fixture>) => { x.catalog.replicationRole = 'replica' }, 'origin triggers'],
  ['missing read-grant observation', (x: ReturnType<typeof fixture>) => { Reflect.deleteProperty(x.catalog, 'serviceRoleMissingReads') }, 'service-role read access'],
  ['missing candidate table', (x: ReturnType<typeof fixture>) => { x.catalog.tables = x.catalog.tables.filter((r: { name: string }) => r.name !== 'edge_invocations') }, 'Catalog tables: missing'],
  ['disabled candidate RLS', (x: ReturnType<typeof fixture>) => { x.catalog.tables.find((r: { name: string }) => r.name === 'edge_invocations').rls = false }, 'Catalog tables: unrecognized or changed object edge_invocations'],
  ['invalid index', (x: ReturnType<typeof fixture>) => { x.catalog.indexes[0].valid = false }, 'Catalog indexes: unrecognized or changed'],
  ['widened waiver policy', (x: ReturnType<typeof fixture>) => { x.catalog.policies[0].using = 'true' }, 'Catalog policies: unrecognized or changed'],
] as const)('fails closed on %s', (_name, mutate, error) => {
  const input = fixture('post-migration')
  mutate(input)
  expect(() => validateSecurityCatalog(input)).toThrow(error)
})

it.each([[], ['--phase=guess'], ['--phase=post-migration', '--phase=pre-migration'],
  ['--phase=post-migration', '--ignore-drift'], ['--phase=pre-migration', '--linked', '--local'],
].map((args) => ({ args })))('rejects absent, ambiguous or unrecognized CLI selection: $args', ({ args }) => {
  expect(() => parseCatalogOptions(args)).toThrow(/Exactly one|Unknown or duplicate/)
})

it('keeps read-only evidence distinct from full readiness and validates links', () => {
  expect(parseCatalogOptions(['--linked', '--phase=pre-migration', '--catalog-only']))
    .toEqual({ phase: 'pre-migration', targets: ['linked'], catalogOnly: true })
  expect(() => validateCatalogTarget({ target: 'linked', linkedRef: 'other', projectRef: release.projectRef })).toThrow('linked ref')
  expect(() => validateCatalogTarget({ target: 'local', linkedRef: release.projectRef, projectRef: release.projectRef })).toThrow('unlinked local')
})

it.each(['valid-pre', 'wrong-phase', 'wrong-link', 'changed-helper', 'local-post', 'nonlocal-url'] as const)('executes the native read-only entry point: %s', (mode) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pancake-catalog-'))
  try {
    const local = mode === 'local-post' || mode === 'nonlocal-url'
    cpSync('supabase/migrations', path.join(dir, 'supabase/migrations'), { recursive: true })
    cpSync('supabase/config.toml', path.join(dir, 'supabase/config.toml'))
    mkdirSync(path.join(dir, 'supabase/.temp'))
    if (!local) writeFileSync(path.join(dir, 'supabase/.temp/project-ref'), mode === 'wrong-link' ? 'other' : release.projectRef)
    mkdirSync(path.join(dir, 'tests'))
    mkdirSync(path.join(dir, 'bin'))
    const input = fixture(local ? 'post-migration' : 'pre-migration')
    if (local) for (const row of input.history.history) {
      row.name = files.find((file) => file.filename.startsWith(row.version + '_'))!.filename.slice(row.version.length + 1, -4)
    }
    if (mode === 'changed-helper') input.catalog.functions.find((r: { name: string }) => r.name === 'lineup_game_started').bodySha256 = '0'.repeat(64)
    writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ rows: [{ snapshot: input.history }] }))
    writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ rows: [{ snapshot: input.catalog }] }))
    writeFileSync(path.join(dir, 'bin/supabase'), `#!/bin/bash
set -e
for arg in "$@"; do case "$arg" in '-- Read'*|'-- Metadata'*) exit 98;; esac; done
if [[ "$1" == status ]]; then echo '{"DB_URL":"postgresql://postgres:postgres@${mode === 'nonlocal-url' ? 'db.invalid' : '127.0.0.1'}:54322/postgres"}'; exit 0; fi
echo query >> calls
case "$*" in *oldHelperCount*) cat history.json;; *serviceRoleMissingReads*) cat catalog.json;; *) exit 99;; esac
`)
    chmodSync(path.join(dir, 'bin/supabase'), 0o700)
    writeFileSync(path.join(dir, 'bin/psql'), `#!${process.execPath}
const fs = require('node:fs'); const sql = fs.readFileSync(0, 'utf8');
if (!sql.includes('BEGIN READ ONLY;') || !sql.trim().endsWith('ROLLBACK;') || !process.argv.includes('--file')) process.exit(97);
fs.appendFileSync('calls', 'query\\n');
const file = sql.includes('oldHelperCount') ? 'history.json' : 'catalog.json';
console.log(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).rows[0].snapshot));
`)
    chmodSync(path.join(dir, 'bin/psql'), 0o700)
    writeFileSync(path.join(dir, 'no-network.mjs'), 'globalThis.fetch = () => { throw new Error("Read-only catalog must not send signup requests") }')
    const phase = mode === 'wrong-phase' || local ? 'post-migration' : 'pre-migration'
    const run = spawnSync(process.execPath, ['--import', path.join(dir, 'no-network.mjs'),
      path.resolve('tests/e2e/db-security-catalog.mjs'), local ? '--local' : '--linked', `--phase=${phase}`, '--catalog-only'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, SUPABASE_PROJECT_REF: release.projectRef,
        PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH },
    })
    expect(run.status, run.stderr).toBe(mode === 'valid-pre' || mode === 'local-post' ? 0 : 1)
    const report = readFileSync(path.join(dir, 'tests/db-security-catalog-readonly-report.md'), 'utf8')
    expect(report).toContain('no signup probe')
    expect(existsSync(path.join(dir, 'tests/db-security-catalog-report.md'))).toBe(false)
    if (mode === 'wrong-link' || mode === 'nonlocal-url') {
      expect(existsSync(path.join(dir, 'calls'))).toBe(false)
      expect(report).toContain(mode === 'wrong-link' ? 'linked ref' : 'loopback URL')
    } else {
      expect(readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n')).toHaveLength(2)
      if (mode === 'wrong-phase') expect(report).toContain('exact post-migration contract')
      if (mode === 'changed-helper') expect(report).toContain('changed object private.lineup_game_started')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('routes every deployment pairing to its explicit database phase', () => {
  const yaml = createRequire(import.meta.url)('js-yaml')
  const deploy = yaml.load(readFileSync('.github/workflows/production-deploy.yml', 'utf8'))
  const pairs = Object.entries(deploy.jobs).filter(([, job]) => (job as { uses?: string }).uses === './.github/workflows/production-readiness.yml')
  expect(pairs).toHaveLength(6)
  for (const [name, job] of pairs) {
    expect((job as { with: { database_phase: string } }).with.database_phase)
      .toBe(name === 'verify-candidate-current-backend' ? 'pre-migration' : 'post-migration')
  }
  const readiness = yaml.load(readFileSync('.github/workflows/production-readiness.yml', 'utf8'))
  expect(readiness.on.workflow_call.inputs.database_phase.required).toBe(true)
  expect(readiness.jobs['verify-production'].env.E2E_DATABASE_PHASE).toBe("${{ inputs.database_phase || 'post-migration' }}")
  const steps = readiness.jobs['verify-production'].steps
  const command = steps.find((step: { name: string }) => step.name === 'Verify linked database security catalog').run
  expect(command).toBe('npm run security:db-catalog -- --linked --phase="$E2E_DATABASE_PHASE"')
  expect(command).not.toContain('--catalog-only')
  const resolve = steps.find((step: { name: string }) => step.name === 'Resolve exact database phase').run
  // Reusable workflows inherit the caller's event; phase must come from the input.
  for (const [event, phase, expected] of [['workflow_dispatch', 'pre-migration', 'pre-migration'],
    ['workflow_dispatch', 'post-migration', 'post-migration'], ['repository_dispatch', 'post-migration', 'post-migration']]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pancake-phase-'))
    try {
      const output = path.join(dir, 'env')
      execFileSync('bash', ['-e', '-c', resolve], { env: { ...process.env, GITHUB_EVENT_NAME: event, E2E_DATABASE_PHASE: phase, GITHUB_ENV: output } })
      expect(readFileSync(output, 'utf8')).toBe(`E2E_DATABASE_PHASE=${expected}\n`)
      const invalid = spawnSync('bash', ['-e', '-c', resolve], { encoding: 'utf8',
        env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_call', E2E_DATABASE_PHASE: '', GITHUB_ENV: output } })
      expect(invalid.status).toBe(1)
      expect(invalid.stdout).toContain('Missing or invalid database phase')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

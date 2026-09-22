import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { planAttestedProductionMigrations } from './e2e/release-soak-migration-plan.mjs'

const attestation = JSON.parse(readFileSync('tests/e2e/release-history-attestations.json', 'utf8'))
const files = readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort().map((filename) => ({
  filename, sha256: createHash('sha256').update(readFileSync(`supabase/migrations/${filename}`)).digest('hex'),
}))
const snapshot = (applied = 0) => ({
  history: files.slice(0, attestation.baselineCount + applied).map(({ filename }) => {
    const version = filename.split('_')[0]
    const alias = attestation.aliases.find((row: { version: string }) => row.version === version)
    const fingerprint = alias ?? attestation.approvedMigrations.find((row: { version: string }) => row.version === version)
    return {
      version, name: alias?.deployedName ?? filename.slice(version.length + 1, -4),
      statementCount: fingerprint?.statementCount ?? 0,
      statementsSha256: fingerprint?.statementsSha256 ?? '',
    }
  }),
  functions: structuredClone(attestation.convergence),
  oldHelperCount: 0, oldHelperReferenceCount: 0,
})

const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8')
const block = workflow.split('      - name: Apply soaked migration range\n')[1].split('      - name:')[0]
const script = 'set -eo pipefail\n' + block.split('        run: |\n')[1].replace(/^          /gm, '')

it('binds the immediate preflight to the successful reusable soak output', () => {
  const soak = readFileSync('.github/workflows/release-soak.yml', 'utf8')
  expect(soak).toContain('value: ${{ jobs.release-soak.outputs.migration_plan_sha256 }}')
  expect(soak).toContain('migration_plan_sha256: ${{ steps.migration-plan.outputs.sha256 }}')
  expect(soak).toContain('id: migration-plan')
  expect(workflow).toContain('needs: [release-soak, verify-candidate-current-backend]')
  expect(workflow).toContain('SOAKED_MIGRATION_PLAN_SHA256: ${{ needs.release-soak.outputs.migration_plan_sha256 }}')
  const command = soak.match(/          plan_sha256=.*\n          printf 'sha256=.*\n/)?.[0]
  expect(command).toBeTruthy()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pancake-plan-output-'))
  try {
    const plan = JSON.stringify(planAttestedProductionMigrations(files, snapshot(), attestation.projectRef))
    const output = path.join(dir, 'output')
    execFileSync('bash', ['-e', '-c', command!], { env: { ...process.env, plan, GITHUB_OUTPUT: output } })
    expect(readFileSync(output, 'utf8')).toBe(`sha256=${createHash('sha256').update(plan).digest('hex')}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  ['valid', 0, 4, 1, ''],
  ['wrong-target', 1, 0, 0, ''],
  ['wrong-link', 1, 0, 0, ''],
  ['link-changes-during-query', 1, 0, 0, ''],
  ['link-changes-before-push', 1, 4, 0, ''],
  ['wrong-source', 1, 0, 0, ''],
  ['missing-soak-digest', 1, 0, 0, ''],
  ['changed-history', 1, 0, 0, 'Production migration plan changed since the successful soak'],
  ['history-changes-before-push', 1, 4, 0, 'Production migration plan changed since the successful soak'],
  ['changed-approved-sql', 1, 0, 0, 'Approved production migration attestation failed at row 321'],
  ['changed-helper', 1, 0, 0, 'Production helper convergence failed at function 1'],
  ['unexpected-pending-file', 1, 0, 0, 'Production history is outside the audited migration range'],
] as const)('executes the production mutation guard: %s', (mode, status, indexes, pushes, message) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pancake-apply-guard-'))
  try {
    mkdirSync(path.join(dir, 'tests/e2e'), { recursive: true })
    cpSync('supabase/migrations', path.join(dir, 'supabase/migrations'), { recursive: true })
    for (const name of ['release-soak-migration-plan.mjs', 'release-history-attestations.json']) {
      cpSync(`tests/e2e/${name}`, path.join(dir, 'tests/e2e', name))
    }
    mkdirSync(path.join(dir, 'bin'))
    // This double can only record calls and emit synthetic metadata. No database is contacted.
    const cli = `#!/bin/bash
set -e
printf '%s\\n' "$*" >> calls
if [ "$1" = link ]; then
  mkdir -p supabase/.temp
  printf '%s' "$SUPABASE_PROJECT_REF" > supabase/.temp/project-ref
  if [ "$MODE" = wrong-link ]; then echo wrong > supabase/.temp/project-ref; fi
elif [[ "$*" == *release-schema-history.sql* ]]; then
  if [ -f queried ]; then cat second.json; else cat first.json; fi
  touch queried
  if [ "$MODE" = link-changes-during-query ]; then echo wrong > supabase/.temp/project-ref; fi
elif [ "$2" = query ]; then
  echo index >> mutations
  if [ "$MODE" = link-changes-before-push ]; then echo wrong > supabase/.temp/project-ref; fi
elif [ "$2" = push ]; then
  echo push >> mutations
fi
`
    writeFileSync(path.join(dir, 'bin/supabase'), cli)
    chmodSync(path.join(dir, 'bin/supabase'), 0o700)
    execFileSync('git', ['init', '--quiet', dir])
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: dir, env: gitEnv })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const first = snapshot(mode === 'changed-history' || mode === 'changed-approved-sql' ? 1 : 0)
    if (mode === 'changed-approved-sql') first.history[320].statementsSha256 = '0'.repeat(64)
    if (mode === 'changed-helper') first.functions[0].bodySha256 = '0'.repeat(64)
    const second = mode === 'history-changes-before-push' ? snapshot(1) : first
    writeFileSync(path.join(dir, 'first.json'), JSON.stringify([{ snapshot: first }]))
    writeFileSync(path.join(dir, 'second.json'), JSON.stringify([{ snapshot: second }]))
    if (mode === 'unexpected-pending-file') writeFileSync(path.join(dir, 'supabase/migrations/20260922000001_unreviewed.sql'), 'select 1;')
    const plan = JSON.stringify(planAttestedProductionMigrations(files, snapshot(), attestation.projectRef))
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir, encoding: 'utf8',
      env: {
        ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
        MODE: mode, RUNNER_TEMP: dir, SUPABASE_DB_PASSWORD: 'synthetic-only',
        SUPABASE_PROJECT_REF: mode === 'wrong-target' ? 'wrong' : attestation.projectRef,
        E2E_RELEASE_SHA: mode === 'wrong-source' ? '0'.repeat(40) : head,
        SOAKED_MIGRATION_PLAN_SHA256: mode === 'missing-soak-digest' ? '' : createHash('sha256').update(plan).digest('hex'),
      },
    })
    expect(result.status, result.stderr).toBe(status)
    expect(result.stderr).toContain(message)
    const mutations = readdirSync(dir).includes('mutations') ? readFileSync(path.join(dir, 'mutations'), 'utf8').trim().split('\n') : []
    expect(mutations.filter((call) => call === 'index')).toHaveLength(indexes)
    expect(mutations.filter((call) => call === 'push')).toHaveLength(pushes)
    if (mode === 'wrong-link') {
      expect(readFileSync(path.join(dir, 'calls'), 'utf8')).not.toContain('release-schema-history.sql')
    }
    if (mode === 'valid') {
      const calls = readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n')
      expect(calls).toHaveLength(8)
      expect(calls[1]).toContain('release-schema-history.sql')
      expect(calls[6]).toContain('release-schema-history.sql')
      expect(calls[7]).toBe('db push --linked --yes')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

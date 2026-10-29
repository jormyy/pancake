import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const runner = resolve('scripts/db-tests.mjs')

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'db-recipe-runner-'))
  mkdirSync(join(directory, 'tests/db/regressions'), { recursive: true })
  mkdirSync(join(directory, 'supabase'))
  mkdirSync(join(directory, 'bin'))
  writeFileSync(join(directory, 'supabase/config.toml'), 'project_id = "recipe-test"\n[db]\nport = 59322\n[api]\nport = 59321\n')
  writeFileSync(join(directory, 'tests/db/known-bugs.json'), '[]')
  writeFileSync(join(directory, 'tests/db/root.sql'), '\\ir helper.sql\nSELECT true;\n')
  writeFileSync(join(directory, 'tests/db/helper.sql'), 'SELECT true;\n')
  writeFileSync(join(directory, 'bin/psql'), '#!/bin/sh\nprintf "%s\\n" "$RECIPE_ERROR" >&2\nexit "$RECIPE_EXIT"\n', { mode: 0o755 })
  const env = { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:59322/postgres',
    SUPABASE_URL: 'http://127.0.0.1:59321', PANCAKE_TEST_DB_PORT: '59322',
    PANCAKE_TEST_API_PORT: '59321', PANCAKE_TEST_PROJECT_ID: 'recipe-test',
    RECIPE_ERROR: '', RECIPE_EXIT: '0' }
  try {
    run(directory, (args = [], changes = {}) => spawnSync(process.execPath, [runner, ...args], {
      cwd: directory, env: { ...env, ...changes }, encoding: 'utf8',
    }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('new SQL assertions run automatically and fail the sweep', () => fixture((directory, run) => {
  assert.equal(run().status, 0)
  writeFileSync(join(directory, 'tests/db/new-assertion.sql'), 'SELECT false;\n')
  const inventory = JSON.parse(run(['--list']).stdout)
  assert.deepEqual(inventory.cases.map(entry => entry.file), ['new-assertion.sql', 'root.sql'])
  assert.deepEqual(inventory.included, ['helper.sql'])
  const failed = run([], { RECIPE_ERROR: 'ERROR: synthetic assertion failed', RECIPE_EXIT: '3' })
  assert.equal(failed.status, 1)
  assert.match(failed.stdout, /FAIL new-assertion.sql/)
  assert.match(failed.stdout, /"failed":2/)
}))

test('known bugs require their exact error and fail when fixed', () => fixture((directory, run) => {
  writeFileSync(join(directory, 'tests/db/regressions/reported.sql'), 'SELECT false;\n')
  writeFileSync(join(directory, 'tests/db/known-bugs.json'), JSON.stringify([
    { file: 'regressions/reported.sql', error: 'BUG: reported defect' },
  ]))
  const reproduced = run(['--bugs'], { RECIPE_ERROR: 'ERROR: BUG: reported defect', RECIPE_EXIT: '3' })
  assert.equal(reproduced.status, 0)
  assert.match(reproduced.stdout, /REPRODUCED BUG/)
  assert.equal(run(['--bugs'], { RECIPE_ERROR: 'ERROR: another defect', RECIPE_EXIT: '3' }).status, 1)
  assert.equal(run(['--bugs']).status, 1)
}))

test('the runner rejects a hosted database before executing recipes', () => fixture((_directory, run) => {
  const result = run([], { SUPABASE_DB_URL: 'postgresql://postgres:postgres@remote.invalid:59322/postgres' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Use a private loopback database/)
  assert.doesNotMatch(result.stdout, /PASS/)
  const overridden = run([], { SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:59322/postgres?host=remote.invalid' })
  assert.equal(overridden.status, 1)
  assert.match(overridden.stderr, /Database target overrides are not allowed/)
}))

test('fixed regressions run in the standard sweep and fail on regression', () => fixture((directory, run) => {
  writeFileSync(join(directory, 'tests/db/regressions/fixed.sql'), 'SELECT true;\n')
  const inventory = JSON.parse(run(['--list']).stdout)
  assert.ok(inventory.cases.some(entry => entry.file === 'regressions/fixed.sql'))
  assert.equal(run().status, 0)
  const failed = run([], { RECIPE_ERROR: 'ERROR: fixed behavior regressed', RECIPE_EXIT: '3' })
  assert.equal(failed.status, 1)
  assert.match(failed.stdout, /FAIL regressions\/fixed.sql/)
}))

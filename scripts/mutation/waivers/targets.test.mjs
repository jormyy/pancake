import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apiTarget, databaseTarget } from './targets.mjs'

test('CI status URLs work without port overrides', () => {
  assert.equal(databaseTarget({ SUPABASE_DB_URL: 'postgresql://postgres@127.0.0.1:54322/postgres' }).port, '54322')
  assert.equal(apiTarget({ SUPABASE_URL: 'http://127.0.0.1:54321' }).port, '54321')
})

test('explicit lane ports accept both local host names', () => {
  assert.equal(databaseTarget({ SUPABASE_DB_URL: 'postgresql://postgres@localhost:57622/postgres', PANCAKE_TEST_DB_PORT: '57622' }).port, '57622')
  assert.equal(apiTarget({ E2E_SUPABASE_URL: 'http://127.0.0.1:57621', PANCAKE_TEST_API_PORT: '57621' }).port, '57621')
})

test('wrong ports, hosts, protocols, and invalid expected ports fail before clients start', () => {
  for (const url of ['postgresql://localhost:57622/postgres', 'postgresql://example.invalid:54322/postgres', 'https://localhost:54322/postgres']) {
    assert.throws(() => databaseTarget({ SUPABASE_DB_URL: url }))
  }
  for (const url of ['http://localhost:57621', 'http://example.invalid:54321', 'ftp://localhost:54321']) {
    assert.throws(() => apiTarget({ SUPABASE_URL: url }))
  }
  for (const port of ['0', '65536', '-1', 'NaN']) {
    assert.throws(() => databaseTarget({ SUPABASE_DB_URL: 'postgresql://localhost:54322/postgres', PANCAKE_TEST_DB_PORT: port }))
  }
})

for (const script of ['run.py', 'verify.py']) {
  test(`${script} accepts configured loopback databases from the current checkout`, async () => {
    const evidence = await mkdtemp(path.join(os.tmpdir(), 'waiver-target-'))
    const wrapper = `
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

script = sys.argv[1]
sys.path.insert(0, str(Path(script).resolve().parent))
sys.argv = sys.argv[1:]
with patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')) as calls:
    try:
        runpy.run_path(script, run_name='__main__')
    except SystemExit as error:
        if error.code != 0:
            raise
    assert calls.call_count > 0, 'The database guard must allow the recipes to run'
`
    try {
      for (const [host, port, override] of [['127.0.0.1', '54322', undefined], ['localhost', '57622', '57622'], ['127.0.0.1', '58622', '58622']]) {
        const env = { ...process.env, SUPABASE_DB_URL: `postgresql://postgres@${host}:${port}/postgres`, PANCAKE_TEST_DB_PORT: override }
        const args = script === 'run.py' ? ['--evidence', evidence, '--baseline-only'] : [evidence]
        const result = spawnSync('/usr/bin/python3', ['-B', '-c', wrapper, `scripts/mutation/waivers/${script}`, ...args], { encoding: 'utf8', env })
        assert.equal(result.status, 0, result.stderr)
      }
      for (const [url, port] of [
        ['postgresql://localhost:57622/postgres', '54322'],
        ['postgresql://example.invalid:54322/postgres', '54322'],
        ['https://localhost:54322/postgres', '54322'],
        ...['0', '65536', '-1', 'NaN', '054322'].map(port => ['postgresql://localhost:54322/postgres', port]),
      ]) {
        const args = script === 'run.py' ? ['--evidence', evidence, '--baseline-only'] : [evidence]
        const result = spawnSync('/usr/bin/python3', ['-B', '-c', wrapper, `scripts/mutation/waivers/${script}`, ...args], {
          encoding: 'utf8', env: { ...process.env, SUPABASE_DB_URL: url, PANCAKE_TEST_DB_PORT: port },
        })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /Refuse a target outside loopback port/)
      }
    } finally { await rm(evidence, { recursive: true, force: true }) }
  })
}

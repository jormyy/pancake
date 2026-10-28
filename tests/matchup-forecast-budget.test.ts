import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.each([299, 300, 301])('enforces the 300 ms forecast read budget at %i ms', elapsedMs => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'forecast-budget-'))
  writeFileSync(path.join(directory, 'psql'), `#!/usr/bin/env node
const sql = process.argv.at(-1)
const value = sql.includes('EXPLAIN') ? [{ 'Planning Time': 0, 'Execution Time': ${elapsedMs}, Plan: { 'Shared Hit Blocks': 100, 'Shared Read Blocks': 0 } }]
  : sql.includes('prepare_matchup_forecast_inputs') ? []
  : { roster: Array(50).fill({}), games: [{}], history: Array(20).fill({ scores: [1] }) }
process.stdout.write(JSON.stringify(value))
`, { mode: 0o755 })
  try {
    const result = spawnSync(process.execPath, ['tests/db/matchup-forecast-budget.mjs', '--matchup-id', '07ad4dd3-bdd2-4d57-9ecd-4e7fe1cef78f'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
        SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:59122/postgres', PANCAKE_TEST_DB_PORT: '59122' },
    })
    expect(result.status).toBe(elapsedMs < 300 ? 0 : 1)
    if (elapsedMs >= 300) expect(result.stderr).toContain('Prepared forecast reads must finish within 300 ms')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

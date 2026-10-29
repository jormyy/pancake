import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

it('observes a SQL boundary before forwarding the real psql completion marker', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'l4c-psql-'))
  try {
    writeFileSync(path.join(directory, 'psql'), '#!/bin/sh\ncat\n', { mode: 0o755 })
    const input = 'SELECT 1;\n\\echo season_sim_abc\n'
    const output = execFileSync(process.execPath, ['tests/perf-l4c/metrics-psql.mjs'], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '63022', PATH: `${directory}:${process.env.PATH}` }, input, encoding: 'utf8',
    })
    expect(output).toContain('PERFORM pg_stat_force_next_flush()')
    expect(output).toContain('PERFORM perf_lab.observe_boundary()')
    expect(output).toContain('RESET statement_timeout;\nRESET lock_timeout;\n')
    expect(output.indexOf('PERFORM perf_lab.observe_boundary()')).toBeLessThan(output.indexOf('\\echo season_sim_abc'))
    expect(output).not.toContain('$l4c_observe$;\\n')
    expect(output).toMatch(/^SELECT 1;\nRESET statement_timeout;/)
  } finally { rmSync(directory, { recursive: true }) }
})

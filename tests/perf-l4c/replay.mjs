import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l4c')
assert.equal(process.env.SEASON_SIM_ROOT, root)
assert.equal(process.env.SEASON_SIM_PROJECT, 'pt4bafableig')
assert.equal(process.env.SEASON_SIM_PORT_PREFIX, '630')
assert.equal(process.cwd(), path.join(root, 'repo'))
const start = process.env.L4C_REPLAY_START ?? '2026-10-29'
assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
process.env.SEASON_SIM_YEAR ??= String(Number(start.slice(0, 4)) + (Number(start.slice(5, 7)) >= 7 ? 1 : 0))
const fixtures = path.join(root, 'window-fixtures')
const window = path.join(root, 'replay-fixtures')
await mkdir(window, { recursive: true })
execFileSync('cp', ['-c', '-R', `${fixtures}/.`, window])
process.env.SEASON_SIM_FIXTURES = window
process.env.SEASON_SIM_ORIGIN_FIXTURES = fixtures
process.env.SEASON_SIM_TWO_DAY = '1'
process.env.SEASON_SIM_DISCRETE_CLOCK = '1'
process.env.SEASON_SIM_DATABASE_WINDOW = path.join(root, 'database-window.json')
const manifest = await readFile(path.join(fixtures, 'manifest.jsonl'))
await mkdir(path.join(root, 'evidence'), { recursive: true })
await writeFile(path.join(root, 'evidence/l4c-fixtures.json'), `${JSON.stringify({
  sha256: createHash('sha256').update(manifest).digest('hex'),
  origin: fixtures, replay: window,
})}\n`)
const { runTwoDay } = await import('../../scripts/perf-lab/two-day.mjs')
const { sql } = await import('../../scripts/season-sim/local-stack.mjs')
try {
  console.log(JSON.stringify(await runTwoDay({ days: '2', start })))
} finally {
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}

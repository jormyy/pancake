import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot } from '../../scripts/season-sim/common.mjs'

assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.equal(process.cwd(), path.join(miniRoot, 'repo'))
const controls = [
  { fn: 'link_player_sources_atomic', test: 'l4c-player-links.sql', message: 'An unchanged source link skips a lost work lease' },
  { fn: 'resolve_player_imports_atomic', test: 'l4c-cdn-known.sql', message: 'Known CDN identities skip a lost work lease' },
  { fn: 'save_game_stats_atomic', test: 'l4c-stat-duplicates.sql', message: 'Duplicate stat identities were accepted' },
]
for (const control of controls) {
  const source = execFileSync('git', ['show', `f68eb86b:supabase/sql/functions/by-name/public/${control.fn}.sql`], { encoding: 'utf8' })
  const recipe = await readFile(new URL(`../db/${control.test}`, import.meta.url), 'utf8')
  const result = spawnSync('docker', ['exec', '-i', config.container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    { input: `BEGIN;\n${source}\n${recipe}`, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes(control.message), result.stderr)
}
await writeFile(path.join(miniRoot, 'evidence/lease-controls.json'), `${JSON.stringify({ unsafeCommit: 'f68eb86b', reproduced: controls.map(row => row.message), passed: true }, null, 2)}\n`)
console.log('L4c ingest controls: 3 guard omissions reproduced')

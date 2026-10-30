import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a2')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const run = input => execFileSync('docker', ['exec', '-i', 'supabase_db_pt4bafablea2', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', timeout: 120000 })
run(await readFile('tests/db/roster-actions-clean-http.sql', 'utf8'))
const manifest = process.argv.find(value => value.startsWith('--dates='))?.slice(8) ?? path.join(lane, 'http-fixture.json')
let dates
try { dates = JSON.parse(await readFile(manifest, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (dates) {
  assert.ok(dates.every(row => /^[a-f0-9-]{36}$/.test(row.id) && /^\d{4}-\d{2}-\d{2}$/.test(row.date)))
  const literal = JSON.stringify(dates).replaceAll("'", "''")
  run(`SET pg_stat_statements.track='none';UPDATE public.waiver_claims claim SET process_date=original.date FROM jsonb_to_recordset('${literal}'::jsonb) AS original(id uuid,date date) WHERE claim.id=original.id;`)
  await rm(manifest)
}
console.log('PASS HTTP fixture cleanup')

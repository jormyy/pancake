import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

assert.equal(process.cwd(), path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a1/repo'))
const file = 'supabase/sql/functions/by-name/public/get_trade_estimate_reanalysis_inputs.sql'
const baseline = execFileSync('git', ['show', `8504722a:${file}`], { encoding: 'utf8' })
const candidate = readFileSync(file, 'utf8')
const query = `SELECT jsonb_agg(jsonb_build_object('id',id,'payload',encode(convert_to(public.get_trade_estimate_reanalysis_inputs(id,'trade-actions-input-parity')::text,'UTF8'),'hex')) ORDER BY id)
  FROM public.trades WHERE status IN ('pending','accepted','completed');`
const results = []
for (const fractional of [false, true]) {
  const input = `BEGIN; SET LOCAL statement_timeout='120s';
    ${fractional ? "UPDATE public.leagues SET scoring_settings=jsonb_set(scoring_settings,'{points}','1.001');" : ''}
    ${baseline}\n${query}\n${candidate}\n${query}\nROLLBACK;`
  const output = execFileSync('psql', ['postgresql://supabase_admin:postgres@127.0.0.1:64322/postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
  const [before, after] = output.trim().split('\n').map(row => JSON.parse(row))
  assert.ok(before.length > 0, 'Backup trade inputs are required')
  assert.deepEqual(after, before, 'Trade reanalysis input bytes changed')
  const wrong = structuredClone(after)
  wrong[0].payload += '20'
  assert.throws(() => assert.deepEqual(wrong, before))
  results.push({ fractional, trades: before.length, identical: true, negativeControls: 1,
    sha256: createHash('sha256').update(JSON.stringify(before)).digest('hex') })
}
writeFileSync('../evidence/reanalysis-input-parity.json', `${JSON.stringify(results, null, 2)}\n`)
console.log(JSON.stringify(results))

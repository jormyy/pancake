import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { command } from '../../scripts/perf-lab/process.mjs'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { scanPlans } from './l3e-plan-audit.mjs'

await requireMini()
assert.equal(project, 'pt4bafablesq')
const file = path.resolve(process.argv[2])
assert.ok(file.startsWith(`${labRoot}/`) || file.startsWith(`${process.cwd()}/tests/db/`))
const input = await readFile(file, 'utf8')
const result = await command('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: `BEGIN; SET LOCAL statement_timeout='120s'; SET LOCAL application_name='l3e-query-capture';
LOAD 'auto_explain'; SET LOCAL auto_explain.log_analyze=on; SET LOCAL auto_explain.log_buffers=on; SET LOCAL auto_explain.log_timing=off;
SET LOCAL auto_explain.log_nested_statements=on; SET LOCAL auto_explain.log_format=json; SET LOCAL auto_explain.log_level=notice;
SET LOCAL auto_explain.log_parameter_max_length=0; SET LOCAL auto_explain.sample_rate=1; SET LOCAL auto_explain.log_min_duration=0;
${input}
ROLLBACK;`, timeout: 240000, label: 'L3e private query capture' })
await writeFile(path.join(labRoot, 'capture-plans.log'), result.stderr)
await writeFile(path.join(labRoot, 'capture-output.txt'), result.stdout)
const scans = scanPlans(result.stderr)
await writeFile(path.join(labRoot, 'capture-scans.json'), JSON.stringify(scans, null, 2))
console.log(JSON.stringify(scans.map(row => ({ ...row, query: row.query.slice(0, 400) })), null, 2))

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { checkFunctionCatalog } from '../../scripts/check-db-function-sources.mjs'

const database = new URL(process.env.SUPABASE_DB_URL)
const config = readFileSync('supabase/config.toml', 'utf8')
assert.equal(database.hostname, '127.0.0.1')
assert.equal(database.port, process.env.PANCAKE_TEST_DB_PORT)
assert.equal(database.port, config.match(/^\[db\]\n(?:(?!\[)[^\n]*\n)*?port\s*=\s*(\d+)\s*$/m)?.[1])
const sql = input => execFileSync('psql', [database.href, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8' }).trim()
const original = sql("SELECT pg_get_functiondef('public.dispatch_work()'::regprocedure)")
assert.deepEqual(await checkFunctionCatalog(), [])
const rejected = []
try {
  for (const statement of ['ANALYZE public.players', 'VACUUM public.players', 'REINDEX TABLE public.players']) {
    sql(`CREATE OR REPLACE FUNCTION public.dispatch_work() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN EXECUTE '${statement}'; RETURN 0; END $$;`)
    const failures = await checkFunctionCatalog()
    assert.ok(failures.some(failure => failure.functionKey === 'public.dispatch_work()' && failure.problem === 'inline database maintenance is restricted to the separate statistics job'))
    rejected.push(statement.split(' ')[0])
  }
} finally {
  sql(original)
}
assert.deepEqual(await checkFunctionCatalog(), [])
console.log(JSON.stringify({ rejected, restored: true }))

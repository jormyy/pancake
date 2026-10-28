import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { requireEnv, resolvedEnv } from './env.mjs'
import { apiTarget } from '../../scripts/mutation/waivers/targets.mjs'

const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey'])
apiTarget({ SUPABASE_URL: env.supabaseUrl, PANCAKE_TEST_API_PORT: process.env.PANCAKE_TEST_API_PORT })
const client = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
const { data, error } = await client.rpc('replace_dynasty_rankings', {
  p_source: 'retired-worker-probe', p_fetched_at: new Date().toISOString(), p_rows: [],
})
assert.ifError(error)
assert.deepEqual(data, { retired: true, source: 'onenumberhoops.com' })
const retained = await client.from('dynasty_rankings').select('id', { count: 'exact', head: true }).eq('source', 'retired-worker-probe')
assert.ifError(retained.error)
assert.equal(retained.count, 0)
console.log(JSON.stringify({ retiredWriter: 'no-op', writes: 0 }))

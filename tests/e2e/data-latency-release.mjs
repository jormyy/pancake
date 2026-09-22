import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv } from './env.mjs'
import { assertLocalLatencyFixtureTarget, withLocalLatencyFixture } from './data-latency-fixture.mjs'

try {
  const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  assertLocalLatencyFixtureTarget(env.supabaseUrl)
  const state = JSON.parse(await readFile('tests/e2e-state.json', 'utf8'))
  const client = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const result = await withLocalLatencyFixture({
    supabaseUrl: env.supabaseUrl, state, client,
    runBenchmark: async () => {
      const result = spawnSync(process.execPath, ['tests/e2e/data-latency-bench.mjs'], { stdio: 'inherit', env: process.env })
      if (result.status !== 0) throw new Error('Release data latency benchmark failed')
    },
  })
  console.log(JSON.stringify({ fixtureCreated: result.fixtureCreated, fixtureCleaned: true, scope: 'isolated loopback database' }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

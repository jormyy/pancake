import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

assert.equal(process.cwd(), path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a1/repo'))
const status = execFileSync('supabase', ['status', '--output', 'env'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
const values = Object.fromEntries([...status.matchAll(/^([A-Z_]+)="([^"]*)"$/gm)].map(match => [match[1], match[2]]))
assert.equal(new URL(values.API_URL).origin, 'http://127.0.0.1:64321')
assert.equal(new URL(values.DB_URL).port, '64322')
assert.ok(values.SECRET_KEY && values.PUBLISHABLE_KEY, 'Private CLI keys are required')
const files = ['api/tradeActivation', 'api/tradeEstimateWork', 'api/pickPredictionWork', '_shared/tradeEstimate',
  'process-trades/activation', 'process-trades/outbox', 'process-trades/receipts', 'process-trades/results']
execFileSync('deno', ['test', '--cached-only', '--no-lock', '--node-modules-dir=manual', '--allow-env', '--allow-net=127.0.0.1,localhost', '--allow-read', '--allow-run=psql', ...files.map(file => `supabase/functions/${file}.test.ts`)], {
  env: { PATH: process.env.PATH, SUPABASE_URL: values.API_URL, SUPABASE_DB_URL: values.DB_URL,
    PANCAKE_SUPABASE_SECRET_KEY: values.SECRET_KEY, E2E_SUPABASE_PUBLISHABLE_KEY: values.PUBLISHABLE_KEY,
    PANCAKE_EDGE_INTERNAL_TOKEN: 'private-trade-activation-test' }, stdio: 'inherit',
})

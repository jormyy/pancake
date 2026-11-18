#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? '')
const flag = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const mode = flag('mode', '')
const date = flag('date', '')
assert.ok(['', 'daily', 'pre_tipoff'].includes(mode), '--mode=daily|pre_tipoff')
assert.ok(!(mode && date), 'Choose --mode or --date, not both')
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.ok(!run.cleanedAt, 'Trigger before cleanup')
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
assert.match(new URL(env.E2E_SUPABASE_URL).hostname, /^(127\.0\.0\.1|localhost)$/)
const functionsEnv = await readFile(path.join(dir, 'functions.env'), 'utf8')
const token = functionsEnv
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('PANCAKE_EDGE_INTERNAL_TOKEN='))
  .map((line) => line.slice('PANCAKE_EDGE_INTERNAL_TOKEN='.length))[0]
assert.ok(token, 'functions.env must contain the generated internal token')
const body = mode ? { mode } : date ? { date } : {}
const response = await fetch(`${env.E2E_SUPABASE_URL}/functions/v1/lineup-optimizer`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-internal-function-token': token,
    'x-request-id': `verify-auto-ir-${Date.now()}`,
  },
  body: JSON.stringify(body),
})
const text = await response.text()
let payload
try { payload = JSON.parse(text) } catch { payload = { raw: text } }
console.log(JSON.stringify({ status: response.status, ok: response.ok, request: body, response: payload }, null, 2))
if (!response.ok) process.exitCode = 1

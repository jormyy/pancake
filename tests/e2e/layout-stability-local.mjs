import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { requireSweepLocal, requireSweepStack, resolveSweepPorts, stackEnvironment } from './layout-stability-ports.mjs'

export function localStackEnvironment(values, ports) {
  requireSweepLocal(values.API_URL, ports.api)
  requireSweepLocal(values.DB_URL, ports.db, ['postgres:', 'postgresql:'])
  const env = {
    EXPO_PUBLIC_SUPABASE_URL: values.API_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: values.PUBLISHABLE_KEY ?? values.ANON_KEY,
    EXPO_PUBLIC_API_URL: `${values.API_URL}/functions/v1/api`,
    E2E_SUPABASE_URL: values.API_URL,
    E2E_SUPABASE_PUBLISHABLE_KEY: values.PUBLISHABLE_KEY ?? values.ANON_KEY,
    E2E_PANCAKE_SUPABASE_SECRET_KEY: values.SECRET_KEY ?? values.SERVICE_ROLE_KEY,
    SUPABASE_DB_URL: values.DB_URL,
    E2E_API_BASE_URL: `${values.API_URL}/functions/v1/api`,
    E2E_FRONTEND_URL: `http://127.0.0.1:${ports.frontend}`,
    LAYOUT_STABILITY_API_PORT: ports.api,
    LAYOUT_STABILITY_DB_PORT: ports.db,
    LAYOUT_STABILITY_FRONTEND_PORT: ports.frontend,
    E2E_ADMIN_SECRET: `layout-local-${randomBytes(16).toString('hex')}`,
    PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token',
  }
  requireSweepStack(env, ports)
  for (const value of Object.values(env)) assert.ok(typeof value === 'string' && value.length > 0 && !/[\r\n`$]/.test(value), 'Invalid generated stack environment')
  return env
}

export async function runLocalSetup(args) {
  const ports = resolveSweepPorts(args, await stackEnvironment(args['stack-env']))
  const output = path.resolve(args['output-dir'] ?? '../evidence/sweep')
  assert.ok(output !== process.cwd() && !output.startsWith(`${process.cwd()}/`), 'Generated local keys and seed output must be outside the checkout')
  const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const values = Object.fromEntries(status.split('\n').flatMap((line) => {
    const match = line.match(/^([A-Z_]+)="(.*)"$/)
    return match ? [[match[1], match[2]]] : []
  }))
  const env = localStackEnvironment(values, ports)
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'local-stack.env'), Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 })
  await writeFile(path.join(output, 'functions.env'), `E2E_ADMIN_SECRET=${env.E2E_ADMIN_SECRET}\nPANCAKE_EDGE_INTERNAL_TOKEN=${env.PANCAKE_EDGE_INTERNAL_TOKEN}\n`, { mode: 0o600 })
  if (args.seed === 'true') {
    await mkdir(path.join(output, 'tests'), { recursive: true })
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./seed-league.mjs', import.meta.url))], { cwd: output, env: { ...process.env, ...env }, stdio: 'inherit' })
    assert.equal(result.status, 0, 'Seed failed')
  }
  process.stdout.write('Generated lane-local environment and requested seed. No credentials printed.\n')
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node tests/e2e/layout-stability-local.mjs --output-dir=PATH [--seed=true] [--api-port=56121] [--db-port=56122] [--frontend-port=56190] [--stack-env=PATH]\nPorts use explicit flags, then stack environment, then the 561xx defaults.\n')
    return
  }
  const known = new Set(['output-dir', 'seed', 'api-port', 'db-port', 'frontend-port', 'stack-env'])
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    assert.ok(arg.startsWith('--') && arg.includes('='), 'Use --name=value arguments; see --help')
    const [key, value] = arg.slice(2).split(/=(.*)/s).slice(0, 2)
    assert.ok(known.has(key), `Unknown option --${key}`)
    return [key, value]
  }))
  await runLocalSetup(args)
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2 })

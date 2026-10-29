import { access } from 'node:fs/promises'
import { command } from './process.mjs'
import { labRoot, ports, project, sourceRoot } from './common.mjs'
import path from 'node:path'

export async function preflight({ full = true, execute = command } = {}) {
  const checks = []
  const check = async (name, file, args, validate = result => result.code === 0) => {
    try {
      const result = await execute(file, args, { allowFailure: true, timeout: 15000 })
      checks.push({ name, passed: validate(result) })
    } catch { checks.push({ name, passed: false }) }
  }
  await check('node22', 'node', ['--version'], result => result.code === 0 && result.stdout.startsWith('v22.'))
  await check('docker', 'docker', ['info', '--format', '{{.ServerVersion}}'])
  await check('supabase', 'supabase', ['--version'])
  await check('deno', 'deno', ['--version'])
  await check('psql', 'psql', ['--version'])
  if (process.env.PERF_LAB_RESTORE !== '0') await check('pg_dump', 'pg_dump', ['--version'])
  if (process.env.PERF_LAB_RESTORE !== '0') await check('pg_restore', 'pg_restore', ['--version'])
  await check('private-stack-free', 'docker', ['ps', '-q', '--filter', `label=com.supabase.cli.project=${project}`], result => result.code === 0 && !result.stdout.trim())
  if (full) {
    if (process.env.PERF_LAB_TLS_SELF_SIGNED === '1') await check('openssl', 'openssl', ['version'])
    else await check('mkcert', 'mkcert', ['-version'])
    await check('webkit', 'node', ['--input-type=module', '-e', 'import {webkit} from "playwright"; import {access} from "node:fs/promises"; await access(webkit.executablePath());'])
    checks.push({ name: 'lan-gateway-authorization', passed: process.env.PERF_LAB_ALLOW_LAN === '1' })
  }
  for (const file of ['node_modules', 'supabase/config.toml']) {
    try { await access(path.join(sourceRoot, file)); checks.push({ name: file, passed: true }) }
    catch { checks.push({ name: file, passed: false }) }
  }
  return { passed: checks.every(check => check.passed), checks, root: labRoot, project, ports }
}

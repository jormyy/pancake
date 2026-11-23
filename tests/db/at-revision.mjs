#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stackConfig } from '../../tools/verify/run.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [rev, ...command] = process.argv.slice(2)
if (!rev || command.length === 0) {
  console.error('Usage: node tests/db/at-revision.mjs <rev> <command...>')
  process.exit(2)
}
const sha = spawnSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], { cwd: repo, encoding: 'utf8' }).stdout.trim()
if (!sha) {
  console.error(`Unknown revision ${rev}`)
  process.exit(2)
}
const id = `pancake-rev-${sha.slice(0, 8)}-${process.pid}`
const base = Number(process.env.PANCAKE_REV_PORT_BASE ?? 20000 + (process.pid % 3000) * 10)
const work = mkdtempSync(path.join(tmpdir(), 'pancake-rev-'))
const run = (program, args, options = {}) => spawnSync(program, args, { cwd: work, stdio: 'inherit', ...options })
const excluded = 'realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'
let status = 1
try {
  const archive = spawnSync('git', ['archive', sha, 'supabase/config.toml', 'supabase/migrations'], { cwd: repo, maxBuffer: 1 << 30 })
  if (archive.status !== 0) throw new Error(`git archive ${sha} failed`)
  spawnSync('tar', ['-x', '-C', work], { input: archive.stdout })
  const config = path.join(work, 'supabase/config.toml')
  writeFileSync(config, stackConfig(readFileSync(config, 'utf8'), id, base).replace(/(\[db\.seed\][^[]*?enabled\s*=\s*)true/, '$1false'))
  if (run('supabase', ['start', '--workdir', work, '-x', excluded]).status !== 0) throw new Error(`supabase start at ${sha} failed`)
  const database = `postgresql://postgres:postgres@127.0.0.1:${base + 1}/postgres`
  console.log(`STACK ${rev} (${sha.slice(0, 8)}) ${database}`)
  status = run(command[0], command.slice(1), {
    cwd: repo,
    env: { ...process.env, SUPABASE_DB_URL: database, PANCAKE_TEST_DB_PORT: String(base + 1), PANCAKE_REVISION: sha },
  }).status ?? 1
} catch (error) {
  console.error(error.message)
} finally {
  run('supabase', ['stop', '--no-backup', '--workdir', work])
  rmSync(work, { recursive: true, force: true })
}
console.log(`EXIT ${rev} ${status}`)
process.exit(status)

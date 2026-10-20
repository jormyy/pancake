#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const index = args.findIndex(value => /^postgres(?:ql)?:\/\//.test(value))
if (index < 0) throw Error('Require the isolated database URL')
const target = new URL(args[index])
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.port !== '56322'
  || target.pathname !== '/postgres' || target.username !== 'postgres') throw Error('Require the postgres database on loopback port 56322')
args.splice(index, 1)
let input
for (let offset = 0; offset < args.length; offset++) {
  const value = args[offset]
  if (/^(--(?:host|port|username|dbname|service)(?:=|$)|-[hpdU])/.test(value)
    || /^postgres(?:ql)?:\/\//.test(value)) throw Error('Connection overrides are forbidden')
  if (value === '-f' || value === '--file' || value.startsWith('--file=')) {
    const file = value.startsWith('--file=') ? value.slice(7) : args[++offset]
    if (!file) throw Error('Require the SQL file path')
    if (file !== '-') {
      if (input !== undefined) throw Error('Only one SQL file is supported')
      input = readFileSync(file)
      args[value.startsWith('--file=') ? offset : offset - 1] = '--file=-'
      if (!value.startsWith('--file=')) args.splice(offset--, 1)
    }
  }
}
const dockerArgs = ['exec', '-i']
if (process.env.PGOPTIONS) dockerArgs.push('--env', 'PGOPTIONS')
dockerArgs.push('supabase_db_pt0493perf', 'psql', '-U', 'postgres', '-d', 'postgres', ...args)
const child = spawnSync('docker', dockerArgs, { stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], input })
if (child.error) throw child.error
process.exit(child.status ?? 1)

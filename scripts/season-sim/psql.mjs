#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertTarget } from './common.mjs'
import { sql } from './local-stack.mjs'

const args = process.argv.slice(2)
let statement = '', database = process.env.SUPABASE_DB_URL
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '-c' || arg === '--command') statement += `${args[++index]}\n`
  else if (arg === '-f' || arg === '--file') statement += `${await readFile(args[++index], 'utf8')}\n`
  else if (arg === '-d' || arg === '--dbname') database = args[++index]
  else if (arg === '--set' || arg === '-v') assert.equal(args[++index], 'ON_ERROR_STOP=1')
  else if (/^postgres(ql)?:/.test(arg)) database = arg
  else assert.ok(['--quiet', '-XqAt', '-X', '-q', '-A', '-t', '-At', '--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1'].includes(arg), `Unsupported psql option: ${arg}`)
}
assertTarget(database, 'db')
if (!statement.trim()) for await (const chunk of process.stdin) statement += chunk.toString()
assert.ok(statement.trim(), 'A SQL command or file is required')
process.stdout.write(`${await sql(statement)}\n`)

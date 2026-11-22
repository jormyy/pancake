#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const baselineRef = process.env.R8_BASELINE_REF ?? '33069cfc'
const cleanEnv = { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', CI: '1' }
if (process.env.PANCAKE_VERIFY_DOCKER_HOST) cleanEnv.DOCKER_HOST = process.env.PANCAKE_VERIFY_DOCKER_HOST
else if (process.env.DOCKER_HOST) cleanEnv.DOCKER_HOST = process.env.DOCKER_HOST

const output = (command, args, cwd = repo) =>
  execFileSync(command, args, { cwd, env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, env: cleanEnv, stdio: 'inherit' })

const stackConfig = (source, id, base) => {
  const portOffsets = { api: 0, db: 1, studio: 2, inbucket: 3, analytics: 6, 'db.pooler': 8 }
  let section = ''
  return source.split('\n').map(line => {
    const header = line.match(/^\[([^\]]+)\]/)
    if (header) section = header[1]
    if (/^project_id\s*=/.test(line)) return `project_id = "${id}"`
    if (/^port\s*=/.test(line) && section in portOffsets) return `port = ${base + portOffsets[section]}`
    if (/^shadow_port\s*=/.test(line)) return `shadow_port = ${base - 1}`
    if (/^inspector_port\s*=/.test(line)) return `inspector_port = ${base + 9}`
    return line
  }).join('\n')
}

const freeBlock = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 3500) * 10
    const sockets = []
    try {
      for (let offset = -1; offset <= 10; offset++) {
        const server = createServer()
        await new Promise((resolve, reject) => server.once('error', reject).listen(base + offset, '127.0.0.1', resolve))
        sockets.push(server)
      }
      return base
    } catch {} finally { for (const socket of sockets) await new Promise(resolve => socket.close(resolve)) }
  }
  throw new Error('No unused local port block')
}

const main = async () => {
  const id = `pancake-r8-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pancake-r8-'))
  const tree = path.join(dir, 'tree')
  const tar = path.join(dir, 'baseline.tar')
  let started = false
  try {
    await mkdir(tree)
    await writeFile(tar, execFileSync('git', ['archive', baselineRef], { cwd: repo, maxBuffer: 256 * 1024 * 1024 }))
    run('tar', ['-x', '-C', tree, '-f', tar])
    const base = await freeBlock()
    const configPath = path.join(tree, 'supabase/config.toml')
    await writeFile(configPath, stackConfig(await readFile(configPath, 'utf8'), id, base))
    run('supabase', ['start', '--workdir', tree, '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime'])
    started = true
    const status = output('supabase', ['status', '--workdir', tree, '-o', 'env'])
    const dbUrl = status.split('\n').map(line => line.match(/^DB_URL="(.*)"$/)).find(Boolean)?.[1]
    assert.ok(dbUrl, 'The disposable stack did not report DB_URL')
    console.log(`R8 stack ${id} at ${dbUrl}`)
    run('psql', [dbUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/r8-tipoff-isolation-migration.sql'])
    run('psql', [dbUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/r8-tipoff-isolation.sql'])
    console.log('PASS r8-tipoff-isolation')
  } finally {
    if (started) {
      try { run('supabase', ['stop', '--workdir', tree, '--no-backup']) } catch (error) { console.error(error.message) }
    }
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })

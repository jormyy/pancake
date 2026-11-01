import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const directory = path.dirname(fileURLToPath(import.meta.url))
export const repository = path.resolve(directory, '../../..')
export const defaultEvidence = path.join(tmpdir(), 'pancake-game-night')
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export const digest = value => createHash('sha256').update(value).digest('hex')
export const quote = value => "'" + String(value).replaceAll("'", "''") + "'"
export const id = n => `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export function loopback(value, ports) {
  const url = new URL(value)
  assert.ok(['http:', 'https:', 'postgres:', 'postgresql:', 'ws:'].includes(url.protocol), 'Unsupported local protocol')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback hosts are allowed')
  if (ports) assert.ok(ports.map(String).includes(url.port), 'Unowned local port')
  return url
}

export async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

export const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

export function command(executable, args, { input = undefined, cwd = repository, env = undefined, timeout = 300000, file = undefined, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGTERM') })
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 16 * 1024 * 1024) child.kill('SIGTERM') })
    child.on('error', reject)
    child.on('close', async code => {
      clearTimeout(timer)
      if (file) await writeFile(file, stdout + stderr, { mode: 0o600 })
      if (code !== 0 && !allowFailure) reject(new Error(`${executable} failed (${code}): ${stderr.slice(-3000)}`))
      else resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

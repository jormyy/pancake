import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as waitTimer } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const home = `/private/tmp/claude-${process.getuid()}/pancake-ios-sim`
export const project = 'pancake_ios_shared'
export const apiUrl = 'http://127.0.0.1:57121'
export const internalToken = 'pancake-ios-local-internal-token'
export const pause = waitTimer
export const digest = value => createHash('sha256').update(value).digest('hex')

export function args(values, allowed) {
  const result = {}
  for (let i = 0; i < values.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(values[i])
    assert.ok(match && allowed.includes(match[1]), `Unknown option ${values[i]}`)
    result[match[1]] = match[2] ?? (values[i + 1]?.startsWith('--') || !values[i + 1] ? true : values[++i])
  }
  return result
}

export function localUrl(value, port) {
  const url = new URL(value)
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password, 'Only loopback HTTP targets are allowed')
  if (port) assert.equal(url.port, String(port), 'Unexpected local stack port')
  return url
}

export async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function run(command, argv = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = '', stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve((options.captureStderr ? `${stdout}\n${stderr}` : stdout).trim()) : reject(new Error(`${command} ${argv.slice(0, 3).join(' ')} failed (${code}): ${stderr.slice(-4000) || stdout.slice(-4000)}`)))
  })
}

export async function lock(directory, action, timeout = 1800000) {
  await mkdir(path.dirname(directory), { recursive: true })
  const started = Date.now()
  while (true) {
    try { await mkdir(directory); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = await readJson(path.join(directory, 'owner.json'))
      if (owner) {
        try { process.kill(owner.pid, 0) } catch (error) {
          if (error.code === 'ESRCH') throw new Error(`Stale lock from a stopped runner: ${directory}. Remove this lock after checking that its owner has stopped.`)
          throw error
        }
      }
      assert.ok(Date.now() - started < timeout, `Lock wait exceeded: ${directory}`)
      await pause(250)
    }
  }
  await json(path.join(directory, 'owner.json'), { pid: process.pid })
  try { return await action() } finally { await rm(directory, { recursive: true, force: true }) }
}

export async function freePort(port) {
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65535, 'Port must be between 1025 and 65534')
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}

export async function ready(url, child, timeout = 120000) {
  localUrl(url)
  const started = Date.now()
  while (Date.now() - started < timeout) {
    assert.ok(!child || child.exitCode === null, 'Owned server exited before it became ready')
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return } catch {}
    await pause(400)
  }
  throw new Error(`Server did not become ready: ${url}`)
}

export async function stopChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 10000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.kill(signal)
  })
}

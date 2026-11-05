import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const directory = path.dirname(fileURLToPath(import.meta.url))
export const root = path.resolve(directory, '../..')
export const cache = path.join(directory, '.cache')
export const digest = value => createHash('sha256').update(value).digest('hex')
export const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil((values.length - 1) * q)]
export function summary(values) {
  assert.ok(values.length && values.every(value => Number.isFinite(value) && value >= 0), 'Invalid measurement')
  return { n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), min: Math.min(...values), max: Math.max(...values) }
}
export function sensitivity(control, slow) {
  const a = summary(control), b = summary(slow)
  return { control: a, slow: b, ratio: b.p50 / a.p50, detected: b.min > a.max, pairs: control.length }
}
export function noise(current, previous) {
  if (!Number.isFinite(previous)) return null
  return { previous, delta: current - previous, percent: previous ? (current / previous - 1) * 100 : 0 }
}
export async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}
export async function command(bin, args, { input, env = {}, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: root, env: { ...process.env, EXPO_NO_DOTENV: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`${bin} ${args.slice(0, 3).join(' ')} exited ${code}: ${stderr.slice(-5000)}${stdout.slice(-2000)}`))
    })
    child.stdin.end(input)
  })
}
export async function fingerprint(files) {
  return digest((await Promise.all(files.map(async file => `${file}\n${await readFile(path.join(root, file), 'utf8')}`))).join('\n'))
}
export const note = value => process.stderr.write(`${value}\n`)

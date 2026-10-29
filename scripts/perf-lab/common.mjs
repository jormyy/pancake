import { labTarget } from './target.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureFileLimit } from './bounded-log.mjs'

export const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const target = labTarget()
export const labRoot = path.join(homedir(), target.relativeRoot)
export const project = target.project
export const ports = Object.freeze(target.ports)
export const evidenceRoot = process.env.PERF_LAB_EVIDENCE_ROOT ?? path.join(homedir(), 'Documents/pancake-season-mission/fable/program3/evidence/lab')
export const digest = value => createHash('sha256').update(value).digest('hex')

export function localTarget(value, allowed = Object.values(ports)) {
  const url = new URL(value)
  assert.ok(['http:', 'https:', 'ws:', 'wss:', 'postgres:', 'postgresql:'].includes(url.protocol), 'Unsupported lab protocol')
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Only loopback lab targets are allowed')
  assert.ok(allowed.includes(Number(url.port)), 'Target is outside the private lab ports')
  assert.equal(url.hash, '', 'Lab targets cannot contain fragments')
  assert.equal(url.username, url.protocol.startsWith('postgres') ? url.username : '', 'HTTP targets cannot contain credentials')
  assert.equal(url.password, url.protocol.startsWith('postgres') ? url.password : '', 'HTTP targets cannot contain credentials')
  return url
}

export async function requireMini() {
  assert.equal(process.env.PERF_LAB_ON_MINI, '1', 'Run this command through perf:lab on the mini')
  assert.equal(await realpath(sourceRoot), path.join(labRoot, 'repo'), 'The lab must use its isolated mini checkout')
  assert.equal(process.versions.node.split('.')[0], '22', 'The lab requires Node 22')
}

export async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  assert.ok(Buffer.byteLength(bytes) <= captureFileLimit, `Capture file limit exceeded: ${path.basename(file)}`)
  await writeFile(`${file}.tmp`, bytes, { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

export const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

export function publicUrl(value) {
  const url = new URL(value)
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]')
  url.username = ''
  url.password = ''
  return url.href
}

export function safeHeaders(headers) {
  const allowed = new Set(['cache-control', 'content-type', 'content-length', 'content-encoding', 'etag', 'last-modified', 'vary', 'age', 'x-cache'])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => allowed.has(key.toLowerCase())))
}

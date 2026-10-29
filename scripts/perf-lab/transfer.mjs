import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { command } from './process.mjs'
import { labRoot, requireMini } from './common.mjs'

export async function transferEntries(evidence, known = []) {
  const entries = (await readdir(evidence)).filter(name => name !== 'history').map(name => `./${name}`)
  const history = await readdir(path.join(evidence, 'history')).catch(() => [])
  for (const id of history) {
    assert.match(id, /^[a-f0-9-]{36}$/, 'Unknown evidence history directory')
    if (!known.includes(id)) entries.push(`./history/${id}`)
  }
  return entries
}

export async function prepareTransfer(evidence, known = [], threshold = 128 * 1024 * 1024) {
  const entries = await transferEntries(evidence, known)
  const directories = ['.', ...entries.filter(entry => entry.startsWith('./history/'))]
  const excludes = []
  for (const relative of directories) {
    const file = path.join(evidence, relative, 'postgres-statements.log.gz')
    const info = await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (!info || info.size <= threshold) continue
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(file)) hash.update(bytes)
    const receipt = JSON.parse(await readFile(path.join(evidence, relative, 'database-run.json'), 'utf8').catch(() => 'null'))
    const archivedPath = relative === '.' && /^[a-f0-9-]{36}$/.test(receipt?.runId ?? '') ? path.resolve(evidence, 'history', receipt.runId, 'postgres-statements.log.gz') : path.resolve(file)
    const record = { file: 'postgres-statements.log.gz', bytes: info.size, sha256: hash.digest('hex'), remotePath: path.resolve(file), archivedPath, retained: true }
    await writeFile(path.join(evidence, relative, 'remote-artifact.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    excludes.push(`./${relative === '.' ? '' : relative.slice(2) + '/'}postgres-statements.log.gz`)
  }
  return { entries: await transferEntries(evidence, known), excludes }
}

export function verifyArchivePaths(listing, details) {
  const files = listing.trim().split('\n').filter(Boolean)
  assert.ok(files.length, 'Evidence archive is empty')
  for (const file of files) assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'), 'Evidence path escapes its directory')
  for (const line of details.trim().split('\n')) assert.ok(['-', 'd'].includes(line[0]), 'Evidence archive contains a link or special file')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await requireMini()
  const known = (process.argv[2] ?? '').split(',').filter(Boolean)
  assert.ok(known.every(id => /^[a-f0-9-]{36}$/.test(id)), 'Invalid known evidence history')
  const transfer = await prepareTransfer(path.join(labRoot, 'evidence'), known)
  await command('tar', ['-czf', path.join(labRoot, 'evidence-transfer.tar.gz'), ...transfer.excludes.map(file => `--exclude=${file}`), '-C', path.join(labRoot, 'evidence'), ...transfer.entries])
}

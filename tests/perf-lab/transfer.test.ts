import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { prepareTransfer } from '../../scripts/perf-lab/transfer.mjs'
import { execFileSync } from 'node:child_process'

it('keeps a large SQL log on the mini and transfers its checked locator with the other evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perf-transfer-'))
  const archive = path.join(tmpdir(), `perf-transfer-${path.basename(root)}.tgz`)
  try {
    const log = 'large SQL capture'
    await writeFile(path.join(root, 'postgres-statements.log.gz'), log)
    await writeFile(path.join(root, 'walk.json'), '[]')
    execFileSync('tar', ['-czf', archive, '-C', root, '.'])
    expect(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })).toContain('postgres-statements.log.gz')
    const transfer = await prepareTransfer(root, [], 4)
    expect(transfer.excludes).toEqual(['./postgres-statements.log.gz'])
    const locator = JSON.parse(await readFile(path.join(root, 'remote-artifact.json'), 'utf8'))
    expect(locator).toMatchObject({ bytes: log.length, sha256: createHash('sha256').update(log).digest('hex'), remotePath: path.join(root, 'postgres-statements.log.gz'), retained: true })
    execFileSync('tar', ['-czf', archive, ...transfer.excludes.map(file => `--exclude=${file}`), '-C', root, ...transfer.entries])
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    expect(listing).toContain('remote-artifact.json')
    expect(listing).toContain('walk.json')
    expect(listing).not.toContain('postgres-statements.log.gz')
    expect(await readFile(locator.remotePath, 'utf8')).toBe(log)
    expect((await prepareTransfer(root, [], 100)).excludes).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }); await rm(archive, { force: true }) }
})

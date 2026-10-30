import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { restoreLock, stackCommand } from './l1-realtime-stack.mjs'

it.each(['dead', 'expired', 'legacy'])('reclaims a %s restore owner and releases only its own lock', async reason => {
    const root = await mkdtemp(join(tmpdir(), 'l1-restore-'))
    const directory = join(root, 'restore.lock')
    try {
        await mkdir(directory)
        await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: 123, startedAt: reason === 'legacy' ? undefined : new Date(Date.now() - (reason === 'expired' ? 46 * 60000 : 0)).toISOString() }))
        if (reason === 'legacy') await utimes(directory, new Date(0), new Date(Date.now() - 46 * 60000))
        const release = await restoreLock({ directory, alive: () => reason !== 'dead' })
        expect(JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')).pid).toBe(process.pid)
        await release()
        await expect(readFile(join(directory, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
})

it('waits for a live restore owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'l1-restore-'))
    const directory = join(root, 'restore.lock')
    try {
        await mkdir(directory)
        await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: 123, startedAt: new Date().toISOString() }))
        const pause = vi.fn(async () => { await rm(directory, { recursive: true }) })
        const release = await restoreLock({ directory, alive: () => true, pause })
        expect(pause).toHaveBeenCalledOnce()
        await release()
    } finally { await rm(root, { recursive: true, force: true }) }
})

it('retries socket EOF with a record and never retries another failure', async () => {
    const run = vi.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'unexpected EOF' }).mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    const pause = vi.fn()
    const record = vi.fn()
    await stackCommand('docker', ['ps'], {}, { run, pause, record })
    expect(run).toHaveBeenCalledTimes(2)
    expect(pause).toHaveBeenCalledWith(2000)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, reason: 'Docker socket EOF' }))
    const failure = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'assertion failed' })
    await expect(stackCommand('docker', ['ps'], {}, { run: failure, pause, record })).rejects.toThrow('failed (1)')
    expect(failure).toHaveBeenCalledOnce()
})

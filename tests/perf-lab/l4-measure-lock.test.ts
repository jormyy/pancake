import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { acquireMeasurementLock, withMeasurementLock, withMeasuredStack } from '../db/perf-l4-measure-lock.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const directory = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'l4-measure-lock-'))
  roots.push(root)
  return path.join(root, 'measure.lock')
}

it('records ownership and releases its own directory', async () => {
  const target = await directory()
  const release = await acquireMeasurementLock(target, 'fable-l4')
  expect(JSON.parse(await readFile(path.join(target, 'owner.json'), 'utf8'))).toMatchObject({ lane: 'fable-l4', startedAt: expect.any(String), pid: process.pid })
  await release()
  await release()
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('waits sixty seconds between attempts while another owner holds the lock', async () => {
  const target = await directory()
  const first = await acquireMeasurementLock(target, 'other-lane')
  const wait = vi.fn(async () => { await first() })
  const second = await acquireMeasurementLock(target, 'fable-l4', wait, vi.fn())
  expect(wait).toHaveBeenCalledExactlyOnceWith(60000)
  await second()
})

it('releases the lock after a failed run', async () => {
  const target = await directory()
  await expect(withMeasurementLock(target, 'fable-l4', async () => { throw new Error('run failed') })).rejects.toThrow('run failed')
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves a replacement owner', async () => {
  const target = await directory()
  const release = await acquireMeasurementLock(target, 'fable-l4')
  await writeFile(path.join(target, 'owner.json'), JSON.stringify({ lane: 'other-lane', token: 'replacement' }))
  await expect(release()).rejects.toThrow('ownership changed')
  expect((await stat(target)).isDirectory()).toBe(true)
})

it('keeps the stack stopped while waiting and stops it after a failed run', async () => {
  const target = await directory()
  const release = await acquireMeasurementLock(target, 'other-lane')
  const calls: string[] = []
  const stack = { stop: async () => { calls.push('stop') }, start: async () => { calls.push('start') } }
  const wait = async () => { calls.push('wait'); await release() }
  await expect(withMeasuredStack(target, 'fable-l4', stack, async () => { calls.push('run'); throw new Error('failed') }, wait, vi.fn())).rejects.toThrow('failed')
  expect(calls).toEqual(['stop', 'wait', 'start', 'run', 'stop'])
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('releases the lock when stack startup fails', async () => {
  const target = await directory()
  const stop = vi.fn()
  await expect(withMeasuredStack(target, 'fable-l4', { stop, start: async () => { throw new Error('startup failed') } }, vi.fn())).rejects.toThrow('startup failed')
  expect(stop).toHaveBeenCalledTimes(2)
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps a direct parent batch lock while stopping between child windows', async () => {
  const target = await directory()
  const release = await acquireMeasurementLock(target,'fable-l4')
  const file = path.join(target,'owner.json')
  const owner = JSON.parse(await readFile(file,'utf8'))
  await writeFile(file,JSON.stringify({ ...owner, pid: process.ppid }))
  const stop = vi.fn(), start = vi.fn()
  await expect(withMeasuredStack(target,'fable-l4',{ stop,start },async () => { throw new Error('child failed') },undefined,undefined,process.ppid)).rejects.toThrow('child failed')
  expect(start).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledTimes(2)
  expect(JSON.parse(await readFile(file,'utf8'))).toMatchObject({ token: owner.token, pid: process.ppid })
  await release()
})

it('rejects a batch grant from a different process or lane', async () => {
  const target = await directory()
  const release = await acquireMeasurementLock(target,'other-lane')
  const start = vi.fn()
  await expect(withMeasuredStack(target,'fable-l4',{ start,stop: vi.fn() },vi.fn(),undefined,undefined,process.pid)).rejects.toThrow('direct parent')
  expect(start).not.toHaveBeenCalled()
  await release()
})

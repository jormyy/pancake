import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detachedReceipt, detachedReplayCommand, shellQuote } from '../../scripts/perf-lab/detached.mjs'
import { requireCompletedReplay } from '../../scripts/perf-lab/collect.mjs'

const id = '00000000-0000-4000-8000-000000000001'

it('quotes shell values without evaluating their substitutions', () => {
  const value = "a'b $(printf unsafe) `printf unsafe`"
  expect(execFileSync('sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' })).toBe(value)
})

it('launches an unlimited full replay with detached input and separate completion evidence', () => {
  const command = detachedReplayCommand(id)
  expect(command).toContain('PERF_LAB_SECONDS=0 nohup sh -c')
  expect(command).toContain('PERF_LAB_CAPTURE_PROFILE=full')
  expect(command).toContain('2>&1 < /dev/null & replay_pid=$!')
  expect(command).toContain('/exit-code')
  expect(command).toContain('/pid')
  execFileSync('sh', ['-n', '-c', command])
  expect(() => detachedReplayCommand('../other')).toThrow()
})

it('requires a real PID and records the frozen source', () => {
  expect(() => detachedReceipt(id, '', 'source')).toThrow()
  expect(() => detachedReceipt(id, 'failed', 'source')).toThrow()
  expect(detachedReceipt(id, '123', 'source', 'control').profile).toBe('control')
  expect(detachedReceipt(id, '123\n', 'source')).toMatchObject({ runId: id, pid: 123, source: 'source', seconds: 0, profile: 'full' })
})

it('collects only a terminal replay with the matching cleaned-up database receipt', () => {
  const complete = { running: false, exitCode: 0, receipt: { runId: id, cleanup: true } }
  expect(requireCompletedReplay(id, complete)).toBe(complete.receipt)
  expect(() => requireCompletedReplay(id, { ...complete, running: true })).toThrow('still running')
  expect(() => requireCompletedReplay(id, { ...complete, exitCode: null })).toThrow('no terminal')
  expect(() => requireCompletedReplay(id, { ...complete, receipt: { runId: 'other', cleanup: true } })).toThrow('before starting')
  expect(() => requireCompletedReplay(id, { ...complete, receipt: { runId: id, cleanup: false } })).toThrow('stack cleanup')
})

it('records a detached process exit code after the launching shell has returned', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perf-detach-'))
  const repo = path.join(root, 'repo'), bin = path.join(root, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\nexit 7\n', { mode: 0o700 })
  try {
    const output = execFileSync('sh', ['-c', detachedReplayCommand(id)], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
    expect(Number.isSafeInteger(Number(output.trim()))).toBe(true)
    let result = ''
    for (let attempt = 0; attempt < 100 && !result; attempt++) {
      result = await readFile(path.join(root, 'runs', id, 'exit-code'), 'utf8').catch(() => '')
      if (!result) await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(result).toBe('7\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})

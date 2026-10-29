import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createBoundedAppender } from '../../scripts/perf-lab/bounded-log.mjs'

it('counts existing content and UTF-8 bytes before appending', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'capture-cap-'))
  const file = path.join(root, 'access.jsonl')
  try {
    await writeFile(file, '1234567')
    const append = createBoundedAppender(10)
    append(file, 'μ')
    expect(() => append(file, 'xx')).toThrow('Capture file limit exceeded')
    expect(await readFile(file, 'utf8')).toBe('1234567μ')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps separate budgets for separate files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'capture-cap-'))
  try {
    const append = createBoundedAppender(4)
    append(path.join(root, 'one'), '1234')
    append(path.join(root, 'two'), 'abcd')
    expect(() => append(path.join(root, 'one'), '5')).toThrow()
    expect(await readFile(path.join(root, 'two'), 'utf8')).toBe('abcd')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('stops SQL capture at its byte limit and runs the logging cutoff once', async () => {
  const { startPostgresLog } = await import('../../scripts/perf-lab/postgres-log.mjs')
  const { spawn } = await import('node:child_process')
  const { gunzipSync } = await import('node:zlib')
  const root = await mkdtemp(path.join(tmpdir(), 'capture-sql-cap-'))
  let cutoffs = 0
  try {
    let done: Promise<unknown> | undefined
    const file = path.join(root, 'postgres.log.gz')
    const capture = startPostgresLog(file, 'now', () => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("query\\n".repeat(1000))'])
      done = new Promise(resolve => child.once('close', resolve))
      return child
    }, { maximumBytes: 128, onLimit: async () => { cutoffs++ } })
    await done
    const status = await capture.close()
    expect(status.limited).toBe(true)
    expect(cutoffs).toBe(1)
    expect(gunzipSync(await readFile(file)).length).toBeLessThanOrEqual(128)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps statement statistics complete while sampling detailed SQL plans', async () => {
  const { captureSettingsSql } = await import('../../scripts/perf-lab/database.mjs')
  expect(captureSettingsSql).toContain("log_min_duration_statement = '-1'")
  expect(captureSettingsSql).toContain("auto_explain.sample_rate = '0.01'")
  expect(captureSettingsSql).toContain("auto_explain.log_min_duration = '25'")
  expect(captureSettingsSql).toContain("pg_stat_statements.track = 'all'")
})

it('caps worker output without stopping the worker', async () => {
  const { captureProcessOutput } = await import('../../scripts/perf-lab/bounded-log.mjs')
  const { spawn } = await import('node:child_process')
  const root = await mkdtemp(path.join(tmpdir(), 'capture-console-'))
  try {
    const file = path.join(root, 'edge.log')
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("1234"); setTimeout(() => process.stderr.write("123456789"), 10)'])
    const log = captureProcessOutput(child, file, 8)
    await new Promise(resolve => child.once('close', resolve))
    expect(child.exitCode).toBe(0)
    expect(log.close()).toMatchObject({ limited: true, discardedBytes: 9 })
    expect((await readFile(file)).length).toBeLessThanOrEqual(8)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('caps console output and still calls write callbacks', async () => {
  const { captureConsole } = await import('../../scripts/perf-lab/bounded-log.mjs')
  const { PassThrough } = await import('node:stream')
  const stream = new PassThrough()
  let text = ''
  stream.on('data', data => { text += data.toString() })
  const capture = captureConsole(4, [stream] as never)
  stream.write('ab')
  await new Promise<void>((resolve, reject) => stream.write('12345', error => error ? reject(error) : resolve()))
  stream.write('cd')
  expect(capture.close()).toMatchObject({ bytes: 2, discardedBytes: 7, limited: true })
  expect(text).toBe('ab')
  stream.end()
})

it('detects critical truncation without treating a console cap as missing request evidence', async () => {
  const { captureLimitMarkers } = await import('../../scripts/perf-lab/bounded-log.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'capture-markers-'))
  try {
    await writeFile(path.join(root, 'access.limit.json'), JSON.stringify({ critical: true, limited: true }))
    await writeFile(path.join(root, 'console.limit.json'), JSON.stringify({ limited: true }))
    expect(captureLimitMarkers([root])).toHaveLength(1)
    captureLimitMarkers([root], true)
    expect(captureLimitMarkers([root])).toEqual([])
    expect(await readFile(path.join(root, 'console.limit.json'), 'utf8')).toContain('limited')
  } finally { await rm(root, { recursive: true, force: true }) }
})

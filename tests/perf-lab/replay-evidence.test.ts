import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { retainedReplay, sameReplayBackend } from '../../scripts/perf-lab/replay-evidence.mjs'

const directories: string[] = []
const source = 'a'.repeat(40)
const id = '00000000-0000-4000-8000-000000000001'
const gates = Object.fromEntries(['liveTicks', 'overnightFinalization', 'preTipoff', 'waivers', 'tradeProposed', 'tradeCountered', 'tradeAccepted', 'forecasts', 'realtime'].map(gate => [gate, true]))

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pancake-replay-evidence-'))
  directories.push(root)
  const archive = path.join(root, 'history', id)
  await mkdir(archive, { recursive: true })
  const simulation = { passed: true, days: 2, fidelity: 'production-cadence', captureProfile: 'control', gates: { ...gates }, source: { application: { commit: source }, committedHarness: true } }
  const receipt = { runId: id, source, cleanup: true, startedAt: '2026-10-28T20:00:00Z' }
  for (const [file, value] of Object.entries({ 'two-day.json': simulation, 'database-run.json': receipt, 'replay-checkpoint.json': { complete: true }, 'job-load-replay.json': {}, 'edge-invocations.jsonl': {}, 'replay-client-access.jsonl': {} })) await writeFile(path.join(archive, file), JSON.stringify(value))
  return { root, archive, simulation, receipt }
}

it('retains a complete archived replay with its original source and artifact hashes', async () => {
  const { root, archive } = await fixture()
  const proof = await retainedReplay(root, (candidate: string) => candidate === source)
  expect(proof?.root).toBe(archive)
  expect(proof?.receipt.source).toBe(source)
  expect(Object.keys(proof?.artifacts ?? {})).toHaveLength(6)
  expect(Object.values(proof?.artifacts ?? {}).every(hash => /^[a-f0-9]{64}$/.test(String(hash)))).toBe(true)
})

it('rejects a replay for a changed backend', async () => {
  const { root } = await fixture()
  expect(await retainedReplay(root, () => false)).toBe(null)
})

it.each(['missing-gate', 'incomplete', 'cleanup', 'missing-artifact', 'uncommitted'])('rejects %s archived evidence', async reason => {
  const { root, archive, simulation, receipt } = await fixture()
  if (reason === 'missing-gate') simulation.gates.waivers = false
  if (reason === 'uncommitted') simulation.source.committedHarness = false
  await writeFile(path.join(archive, 'two-day.json'), JSON.stringify(simulation))
  if (reason === 'incomplete') await writeFile(path.join(archive, 'replay-checkpoint.json'), '{"complete":false}')
  if (reason === 'cleanup') await writeFile(path.join(archive, 'database-run.json'), JSON.stringify({ ...receipt, cleanup: false }))
  if (reason === 'missing-artifact') await rm(path.join(archive, 'edge-invocations.jsonl'))
  expect(await retainedReplay(root, () => true)).toBe(null)
})

it('rejects an unknown source without invoking it as a Git argument', () => {
  expect(sameReplayBackend('HEAD')).toBe(false)
  expect(sameReplayBackend('a'.repeat(40), '/missing-repository')).toBe(false)
})

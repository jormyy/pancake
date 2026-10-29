import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderReport, sameControlSurface } from '../../scripts/perf-lab/report.mjs'

const fixtureCommit = vi.hoisted(() => 'a'.repeat(40))
vi.mock('../../scripts/perf-lab/replay-evidence.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../scripts/perf-lab/replay-evidence.mjs')>()
  return {
    ...actual,
    retainedReplay: (root: string) => actual.retainedReplay(root, (candidate: string) => candidate === fixtureCommit),
  }
})

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('recognizes default section URLs without treating other tabs as the same control surface', () => {
  expect(sameControlSurface('/players', '/players?section=players')).toBe(true)
  expect(sameControlSurface('/trades?tab=offers', '/trades')).toBe(true)
  expect(sameControlSurface('/players', '/players?section=rankings')).toBe(false)
  expect(sameControlSurface('/trades', '/trades?tab=block')).toBe(false)
})

it('renders current contracts, control ownership and separate replay network layers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pancake-report-'))
  directories.push(root)
  for (const name of ['app', 'components', 'contexts', 'hooks', 'lib', 'public', 'scripts', 'supabase', 'tests']) {
    await symlink(path.join(process.cwd(), name), path.join(root, name), 'dir')
  }
  await mkdir(path.join(root, 'docs'))
  const evidenceRoot = path.join(root, 'evidence')
  await mkdir(evidenceRoot)
  const request = { method: 'POST', url: 'http://127.0.0.1:57281/functions/v1/api', bytesIn: 5, bytesOut: 9, status: 200, durationMs: 4 }
  await writeFile(path.join(evidenceRoot, 'replay-client-access.jsonl'), `${JSON.stringify(request)}\n${JSON.stringify(request)}\n`)
  await writeFile(path.join(evidenceRoot, 'replay-edge-access.jsonl'), `${JSON.stringify(request)}\n`)
  const workers = [
    { function: 'live-poll', at: '2025-10-23T02:15:00Z', realAt: '2026-10-28T12:00:10Z', durationMs: 10000, status: 200 },
    { function: 'refresh-views', at: '2025-10-23T02:20:00Z', realAt: '2026-10-28T12:00:20Z', durationMs: 2000, status: 500 },
  ]
  await writeFile(path.join(evidenceRoot, 'edge-invocations.jsonl'), workers.map(row => JSON.stringify(row)).join('\n'))
  await writeFile(path.join(evidenceRoot, 'job-load-replay.json'), JSON.stringify({ byTotal: [
    { queryid: '1', query: 'SELECT season_sim.time(season_sim.real_transaction())', calls: 1000, total_exec_time: 22, rows_returned_or_affected: 1000, shared_blks_hit: 1000, shared_blks_read: 0 },
  ] }))
  const { report } = await renderReport({ root, evidenceRoot })
  expect(Reflect.get(report, 'startingNetwork').resourceTypes[0]).toMatchObject({ id: 'JavaScript', bytesDown: 4130315 })
  expect(Reflect.get(report, 'startingNetwork').resourceTypes.reduce((sum: number, row: { requests: number }) => sum + row.requests, 0)).toBe(52)
  expect(Reflect.get(report, 'startingNetwork').endpoints.reduce((sum: number, row: { bytesDown: number }) => sum + row.bytesDown, 0)).toBe(4563599)
  expect(Reflect.get(report, 'replayNetwork')).toMatchObject([
    { layer: 'client', requests: 2, bytesDown: 18, bytesUp: 10, durationMs: 8 },
    { layer: 'edge', requests: 1, bytesDown: 9, bytesUp: 5, durationMs: 4 },
  ])
  expect(Reflect.get(report, 'runtime')).toMatchObject({
    matched: { calls: 1, spanMs: 10000, errors: 0 },
    current: { calls: 2, spanMs: 20000, durationMs: 12000, errors: 1 },
    comparable: true,
    complete: false,
  })
  const lines = (await readFile(path.join(root, 'docs/data-flow.md'), 'utf8')).split('\n')
  expect(lines).toContain('## Final ranked screen baseline')
  expect(Reflect.get(report, 'perScreen')).toHaveLength(41)
  expect(lines).toContain('| forecasts | failed: matchup-forecast / 55P03 |')
  expect(lines).toContain('The frozen starting matchup records 43 cold requests / 4500930 down bytes and 9 warm requests / 62669 down bytes.')
  expect(lines).toContain('Cost × frequency is total response bytes. These archived results do not prove the current release.')
  expect(lines).toContain('| JavaScript | 22 / 4123954 | 2 / 6361 |')
  expect(lines).toContain('| service worker | 1 / 36876 | 1 / 36876 |')
  expect(lines).toContain('| Initial endpoint | Cold requests / down bytes | Warm requests / down bytes |')
  expect(lines).toContain('| API endpoint | Requests | Mean down bytes | Cost × frequency bytes |')
  expect(lines).toContain('| Before empty-state and Analyzer captures | 136 | 224688182 |')
  expect(lines.some(line => line.startsWith('| 3e7a89ab | full | client | 423307 | 369370760 | 14598 |'))).toBe(true)
  const cohort = Reflect.get(report, 'cohort')
  expect(cohort.observations).toHaveLength(212)
  expect(cohort.ranking.resourceTypes.reduce((sum: number, row: { bytesDown: number }) => sum + row.bytesDown, 0)).toBe(527422874)
  expect(lines).toContain('| Before final closure capture | 167 | 340209971 |')
  expect(lines.findIndex(line => line === '## Starting workload targets')).toBeLessThan(lines.findIndex(line => line.startsWith('| Screen | Incoming data')))
  expect(lines.find(line => line.startsWith('| /players · players |'))).toContain('pancake:screen-view:v1:')
  expect(lines.some(line => line.includes('never queue gameplay writes offline'))).toBe(false)
  expect(lines.find(line => line.startsWith('| /lineup · lineup-editor |'))).toContain('/league/lineup/auto-set-season')
  expect(lines.find(line => line.startsWith('| /trades · trades |'))).toContain('/trades/:id/accept')
  const analyzer = lines.find(line => line.startsWith('| /trades?tab=analyzer · trades.analyzer |'))
  expect(analyzer).toContain('/trades/estimate')
  expect(analyzer).toContain('/trades/:id/revalue')
  expect(analyzer).toContain('pancake:dynasty-analyzer-snapshot:v7:')
  expect(analyzer).toContain('300 ms')
  expect(lines).toContain('Replay uses the current account and the original request ID. A failed write stops the queue until retry.')
  expect(lines).toContain('Requested pick season: 2030. Available future seasons: 2027, 2028, 2029.')
  expect(lines).toContain('API request sent: no. Failure point: scripts/season-sim/trade-scenarios.mjs:11.')
  expect(lines.find(line => line.startsWith('| /propose-trade · propose-trade |'))).toContain('pancake:trade-editor-context:v1:')
  expect(lines).toContain('| Current through prior cutoff | 2025-10-23T02:15:00.000Z | 1 | 10000.00 | 10000.00 | 0 | partial |')
  expect(lines).toContain('| Current, incomplete | transaction | 1000 | 22.00 | 0.022000 | 4.400 | 1000 | 1000 |')
  expect(lines).toContain('| Current, incomplete | 1 | 1000 | 0.0220 | 22.00 | 1000 | 1000 | SELECT season_sim.time(season_sim.real_transaction()) |')
  const matrix = (await readFile(path.join(root, 'docs/screen-matrix.md'), 'utf8')).split('\n')
  expect(matrix.find(line => line.includes('| player-from-players/0/0 |'))).toMatch(/^\| \/players \|/)
  expect(matrix.find(line => line.includes(' · claim-player | commissioner | in-progress | empty |'))).toContain('FAAB bid amount')
  expect(matrix.find(line => line.includes(' · notification-settings | commissioner | in-progress | empty |'))).toContain('Empty-state fixture not implemented')
  expect(matrix).toContain('| Current full run | 2025-10-23T02:20:00.000Z | 2 | 20000.00 | 12000.00 | 1 | not passed |')
  const simulation = { captureProfile: 'control', passed: true, days: 2, fidelity: 'production-cadence', gates: Object.fromEntries(['liveTicks', 'overnightFinalization', 'preTipoff', 'waivers', 'tradeProposed', 'tradeCountered', 'tradeAccepted', 'forecasts', 'realtime'].map(name => [name, true])) }
  const lighter = await renderReport({ root, evidenceRoot, simulation })
  expect(lighter.report).toMatchObject({ simulationGatePassed: true, simulationPassed: true, fullCapturePassed: false, simulationProfile: 'control', done: false })
  const missingGate = await renderReport({ root, evidenceRoot, simulation: { ...simulation, gates: { ...simulation.gates, waivers: false } } })
  expect(missingGate.report).toMatchObject({ simulationGatePassed: false, simulationPassed: false, fullCapturePassed: false })
  const full = await renderReport({ root, evidenceRoot, simulation: { ...simulation, captureProfile: 'full' } })
  expect(full.report).toMatchObject({ simulationPassed: true, fullCapturePassed: true })
  await writeFile(path.join(evidenceRoot, 'database-run.json'), JSON.stringify({ captureComplete: false }))
  const truncated = await renderReport({ root, evidenceRoot, simulation: { ...simulation, captureProfile: 'full' } })
  expect(truncated.report).toMatchObject({ simulationPassed: true, fullCapturePassed: false, done: false })
  const archived = path.join(evidenceRoot, 'history', '00000000-0000-4000-8000-000000000001')
  await mkdir(archived, { recursive: true })
  const source = fixtureCommit
  await writeFile(path.join(archived, 'two-day.json'), JSON.stringify({ ...simulation, source: { application: { commit: source }, committedHarness: true } }))
  await writeFile(path.join(archived, 'database-run.json'), JSON.stringify({ runId: path.basename(archived), source, cleanup: true, startedAt: '2026-10-28T20:00:00Z' }))
  await writeFile(path.join(archived, 'replay-checkpoint.json'), '{"complete":true}')
  for (const file of ['edge-invocations.jsonl', 'job-load-replay.json', 'replay-client-access.jsonl']) await copyFile(path.join(evidenceRoot, file), path.join(archived, file))
  const retained = await renderReport({ root, evidenceRoot })
  expect(retained.report).toMatchObject({ simulationPassed: true, fullCapturePassed: false, simulationProfile: 'control', runtime: { complete: true, current: { calls: 2 } }, replayEvidence: { source, root: archived, retained: true } })
  expect(Reflect.get(retained.report, 'replayNetwork')[0].file).toBe(path.join(archived, 'replay-client-access.jsonl'))
  const failedReplay = await renderReport({ root, evidenceRoot, simulation: { ...simulation, attempted: true, passed: false } })
  expect(failedReplay.report.simulationPassed).toBe(false)
  expect(failedReplay.report.replayEvidence?.retained).toBe(false)
}, 15000)

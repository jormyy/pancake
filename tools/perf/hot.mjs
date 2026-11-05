import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'
import { cache, root, command, summary, sensitivity } from './common.mjs'

export async function hotWorkloads() {
  const out = path.join(cache, 'core')
  await command(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'core/tsconfig.cjs.json', '--outDir', out])
  const require = createRequire(import.meta.url)
  const { overlayLiveScores } = require(path.join(out, 'live/overlay.js'))
  const { analyzeDynastyTrade } = require(path.join(out, 'dynasty/tradeScoring.js'))
  const shared = path.join(cache, 'auto')
  await mkdir(shared, { recursive: true })
  for (const name of ['autoSetAssignments', 'lineupSlots']) {
    const text = await readFile(path.join(root, `supabase/functions/_shared/${name}.ts`), 'utf8')
    const compiled = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll('./lineupSlots.ts', './lineupSlots.js')
    await writeFile(path.join(shared, `${name}.js`), compiled)
  }
  const { chooseAutoSetAssignments } = require(path.join(shared, 'autoSetAssignments.js'))
  const positions = ['PG', 'SG', 'SF', 'PF', 'C']
  const players = Array.from({ length: 18 }, (_, i) => ({ playerId: `p${i}`, eligiblePositions: [positions[i % 5], positions[(i + 1) % 5]], projected: 20 + i, avoidInLineup: i === 17, gameTime: `2026-11-04T${20 + i % 4}:00:00Z` }))
  const slots = ['PG','SG','SF','PF','C','G','F','UTIL','UTIL','UTIL']
  const now = 1793818800000
  const settings = { points: 1, rebounds: 1.2, assists: 1.5, steals: 3, blocks: 3, turnovers: -1, three_pointers_made: 0.5 }
  const games = Array.from({ length: 15 }, (_, i) => ({ id: `g${i}`, nbaId: `g${i}`, status: 'InProgress', updatedAt: now, home: { team: `T${i * 2}`, score: 80, players: [] }, away: { team: `T${i * 2 + 1}`, score: 75, players: [] } }))
  for (let i = 0; i < 450; i++) games[Math.floor(i / 30)][i % 30 < 15 ? 'home' : 'away'].players.push([String(1000 + i),20,7,6,1,1,2,3,7,15,3,4,2,28,0])
  const saved = Array.from({ length: 6 }, (_, m) => ({ id: `m${m}`, homeMemberId: `t${m * 2}`, awayMemberId: `t${m * 2 + 1}`, homePoints: 100, awayPoints: 100, finalized: false, ready: true, players: Array.from({ length: 36 }, (_, j) => {
    const i = m * 36 + j
    return { playerId: `p${i}`, memberId: `t${m * 2 + (j < 18 ? 0 : 1)}`, nbaId: String(1000 + i), espnId: null, team: `T${Math.floor(i / 15)}`, gameId: `g${Math.floor(i / 30)}`, savedPoints: 0, savedAt: now - 1000, starter: j % 18 < 10 }
  }) }))
  const snapshot = { version: 1, mode: 'public', date: '2026-11-04', capturedAt: now, games }
  const rosters = Array.from({ length: 12 }, (_, m) => ({ memberId: `t${m}`, limits: { active: 15, ir: 3, taxi: 3 }, players: Array.from({ length: 18 }, (_, p) => ({ playerId: `p${m * 18 + p}`, tradeValue: 300 + p * 20, location: 'active' })) }))
  const routes = Array.from({ length: 12 }, (_, i) => ({ fromMemberId: `t${Math.floor(i / 4)}`, toMemberId: `t${(Math.floor(i / 4) + 1) % 3}`, asset: { kind: 'player', id: `p${Math.floor(i / 4) * 18 + i % 4}`, label: `Player ${i}`, tradeValue: 400 + i * 25 } }))
  return [
    { name: 'chooseAutoSetAssignments', source: 'supabase/functions/_shared/autoSetAssignments.ts', size: { roster: 18, slots: 10, dates: 7 }, run: () => Array.from({ length: 7 }, (_, d) => chooseAutoSetAssignments(slots, players, p => (Number(p.playerId.slice(1)) + d) % 3 !== 0)), check: value => value.length === 7 && value.every(day => day.length === 10 && new Set(day.map(p => p.playerId)).size === 10), consume: value => value.reduce((sum, day) => sum + day.length, 0) },
    { name: 'overlayLiveScores', source: 'core/src/live/overlay.ts', size: { matchups: 6, rosterPlayers: 216, liveGames: 15, livePlayerLines: 450 }, run: () => overlayLiveScores(saved, snapshot, settings, now), check: value => value.matchups.length === 6 && !value.stale && Object.keys(value.stats).length === 216 && value.matchups.every(m => m.homePoints > 100 && m.awayPoints > 100), consume: value => value.matchups.reduce((sum, m) => sum + m.homePoints + m.awayPoints, 0) },
    { name: 'analyzeDynastyTrade', source: 'core/src/dynasty/tradeScoring.ts', size: { leagueTeams: 12, rosterPlayers: 216, participants: 3, routedAssets: 12 }, run: () => analyzeDynastyTrade({ rosters }, 'overall', routes), check: value => value.teams.length === 3 && value.assets.length === 12 && value.teams.every(t => Number.isFinite(t.netValue)), consume: value => value.teams.reduce((sum, t) => sum + t.valuesSent, 0) },
  ]
}

export async function measureHot(n) {
  const workloads = await hotWorkloads()
  const errors = [], metrics = []
  let workDone = 0, checksum = 0
  function batch(item, count, repeat = 1) {
    const start = performance.now()
    for (let i = 0; i < count; i++) for (let j = 0; j < repeat; j++) checksum += item.consume(item.run())
    workDone += count * repeat
    return (performance.now() - start) * 1e6 / count
  }
  for (const item of workloads) {
    try {
      assert.ok(item.check(item.run()), `${item.name} output validation failed`)
      batch(item, 30)
      const pilot = batch(item, 10)
      const count = Math.min(10000, Math.max(2, Math.ceil(20e6 / pilot)))
      const samples = Array.from({ length: n }, () => batch(item, count))
      metrics.push({ name: item.name, source: item.source, size: item.size, nsPerOp: summary(samples), batchSize: count, samples, allocations: null, allocationNote: 'Retained heap is not allocation volume; allocation counts are unavailable without perturbing these timings.' })
    } catch (error) { errors.push(error.message) }
  }
  const control = [], slow = []
  const item = workloads[0]
  for (let i = 0; i < 5; i++) { control.push(batch(item, 10)); slow.push(batch(item, 10, 4)) }
  const proof = sensitivity(control, slow)
  if (!proof.detected) errors.push('Hot-loop sensitivity failed')
  assert.ok(checksum > 0)
  return { errorCount: errors.length, errors, workDone, checksum, metrics, sensitivity: proof, unit: 'ns per complete workload', runtime: 'Node production JavaScript; warm JIT; no CPU throttle' }
}

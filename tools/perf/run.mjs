import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cache, command, fingerprint, json, noise, note } from './common.mjs'
import { startDatabase, seedDatabase, measureData } from './database.mjs'
import { buildClient, serveClient, measureClient } from './client.mjs'
import { measureHot } from './hot.mjs'

if (process.argv[2] === 'public-cli-scale') {
  process.argv.splice(2, 1)
  await import('./public-cli-scale.mjs')
} else {
  const report = { version: 1, startedAt: new Date().toISOString(), claim: 'A repeatable local baseline, not a speedup or a device timing claim.', environment: { node: process.version, platform: os.platform(), arch: os.arch(), cores: os.cpus().length, load: os.loadavg() }, errorCount: 0, cleanup: false }
  let db, server
  try {
    report.source = (await command('git', ['rev-parse', 'HEAD'])).trim()
    report.harness = await fingerprint(['tools/perf/run.mjs', 'tools/perf/common.mjs', 'tools/perf/database.mjs', 'tools/perf/client.mjs', 'tools/perf/hot.mjs', 'tools/perf/seed.sql', 'tools/perf/edge.mjs', 'scripts/bench/profile-seed.sql', 'supabase/sql/functions/by-name/private/rebuild_game_player_totals.sql', 'tests/e2e/pwa-paint-probe.mjs'])
    report.hot = await measureHot(15)
    db = await startDatabase()
    const seed = await seedDatabase(db)
    const { session, ...publicSeed } = seed
    report.seed = publicSeed
    report.data = await measureData(db, seed, 15)
    const build = await buildClient(db)
    server = await serveClient(db, build)
    report.client = await measureClient(seed, build)
  } catch (error) {
    report.failure = error.message
    report.errorCount++
  } finally {
    try { if (server) await server.stop() } catch (error) { report.cleanupFailure = error.message; report.errorCount++ }
    try { if (db) await db.stop(); report.cleanup = true } catch (error) { report.cleanupFailure = error.message; report.errorCount++ }
    for (const section of ['hot', 'data', 'client']) report.errorCount += report[section]?.errorCount ?? 0
    const previous = await readFile(path.join(cache, 'last.json'), 'utf8').then(JSON.parse).catch(() => null)
    report.noise = { comparable: Boolean(previous && previous.errorCount === 0 && previous.source === report.source && previous.harness === report.harness), previousStartedAt: previous?.startedAt ?? null, metrics: [] }
    if (report.noise.comparable) {
      for (const row of report.data?.metrics ?? []) {
        const prior = previous.data?.metrics.find(item => item.rpc === row.rpc)
        for (const metric of ['latencyMs', 'responseBytes']) for (const percentile of ['p50', 'p95']) report.noise.metrics.push({ name: `${row.rpc}.${metric}.${percentile}`, ...noise(row[metric][percentile], prior?.[metric]?.[percentile]) })
      }
      for (const row of report.hot?.metrics ?? []) {
        const prior = previous.hot?.metrics.find(item => item.name === row.name)
        report.noise.metrics.push({ name: `${row.name}.nsPerOp.p50`, ...noise(row.nsPerOp.p50, prior?.nsPerOp.p50) })
      }
      for (const row of report.client?.metrics ?? []) {
        const prior = previous.client?.metrics.find(item => item.screen === row.screen && item.state === row.state)
        for (const metric of ['meaningfulPaintMs', 'interactiveMs']) for (const percentile of ['p50', 'p95']) report.noise.metrics.push({ name: `${row.screen}.${row.state}.${metric}.${percentile}`, ...noise(row[metric][percentile], prior?.[metric]?.[percentile]) })
        report.noise.metrics.push({ name: `${row.screen}.${row.state}.initialJsBytes`, ...noise(row.initialJsBytes, prior?.initialJsBytes) })
      }
      if (report.client && previous.client) for (const row of report.client.routeInitialChunks) report.noise.metrics.push({ name: `${row.route}.staticInitialJsBytes`, ...noise(row.bytes, previous.client.routeInitialChunks.find(item => item.route === row.route)?.bytes) })
      if (report.client && previous.client) report.noise.metrics.push({ name: 'client.totalJsBytes', ...noise(report.client.totalJsBytes, previous.client.totalJsBytes) })
    }
    report.finishedAt = new Date().toISOString()
    await json(path.join(cache, 'last.json'), report)
    await json(path.join(cache, `run-${report.startedAt.replaceAll(':', '-')}.json`), report)
    console.log(JSON.stringify(report, null, 2))
    note(`Complete: ${report.errorCount} errors; cleanup ${report.cleanup}.`)
    if (report.errorCount) process.exitCode = 1
  }
}

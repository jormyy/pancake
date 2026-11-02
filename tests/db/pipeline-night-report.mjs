import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { comparePairs } from './pipeline-night-gates.mjs'

const directory = path.resolve(process.argv[2])
const read = name => JSON.parse(readFileSync(path.join(directory, `${name}.json`), 'utf8'))
const names = ['candidate', 'native-context', 'native-context-batch', 'source-selector', 'generic', 'generic-prepare-steady', 'context-isolated', 'baseline']
const stack = read('stack')
const experiments = names.filter(name => existsSync(path.join(directory, `${name}.json`))).map(name => {
  const report = read(name)
  const correctedCounters = ['candidate', 'native-context', 'native-context-batch', 'source-selector'].includes(name)
  const liveFrames = (report.quality.find(row => row.name === 'live-cycle')?.values ?? []).map((value, index) => {
    const visible = value.visible.find(row => row.matchup_id === value.context.matchupId)
    assert.ok(visible)
    assert.equal(visible.home_points, value.context.teams[0].currentPoints)
    assert.equal(visible.away_points, value.context.teams[1].currentPoints)
    return { frame: index + 1, currentTotalsVisible: true }
  })
  return { name, mode: report.mode, source: report.source, baseline: report.baseline, concurrent: report.concurrent, correctedCounters,
    attemptSources: report.attemptSources ?? [report.source],
    liveFrames,
    evictShared: report.evictShared ?? false, nativeClock: report.nativeClock ?? false, batchSize: report.samples[0]?.batchSize ?? 1,
    extraWarmup: report.extraWarmup ?? 0, started: report.started, finished: report.finished,
    quality: report.quality.map(({ name, pass, touched, hash }) => ({ name, pass, touched, hash })),
    samples: report.samples.map(({ name, fn, phase, round, cache, ms, hit, read, wal, nested, batchSize = 1, rowsWritten, written, followup, evicted }) => {
      const statements = correctedCounters ? nested.filter(row => !row.query.includes('pg_stat_statements')
        && !/^SELECT set_config\(\$\d+,n::text,/.test(row.query)
        && !/^SELECT current_setting\(\$\d+\)::timestamptz\s*$/.test(row.query)).reduce((sum, row) => sum + row.calls, 0) / batchSize : undefined
      return { name, fn, phase, round, cache, batchSize, ms, hit, read, wal, statements, rowsWritten, written, followup, evicted,
        queueFixtureVerified: !(name.startsWith('dispatch-') || name === 'live-cycle') || report.mode === 'candidate' && !report.selected }
    }) }
})
const final = experiments.find(row => row.name === 'candidate')
assert.ok(final?.evictShared)
const order = ['dispatch_work', 'get_trade_revaluation_inputs', 'save_live_feed_snapshot_atomic', 'get_matchup_forecast_context',
  'get_prepared_matchup_forecast_context', 'get_matchup_forecast', 'update_score_points_atomic', 'prepare_matchup_forecast_inputs',
  'complete_matchup_forecast', 'link_player_sources_atomic', 'resolve_player_imports_atomic', 'capture_score_inputs', 'get_live_poll_work']
const cases = [...new Set(final.samples.map(row => row.name))].sort((a, b) =>
  order.indexOf(final.samples.find(row => row.name === a).fn) - order.indexOf(final.samples.find(row => row.name === b).fn) || a.localeCompare(b))
assert.equal(cases.length, final.quality.length)
const mean = (rows, key) => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0) / rows.length
const number = value => Number(value.toFixed(3)).toString()
const lines = []
for (const name of cases) {
  const samples = final.samples.filter(row => row.name === name)
  lines.push(`### ${name}`, '', '| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const phase of ['baseline', 'candidate']) {
    const fresh = samples.filter(row => row.phase === phase && row.cache === 'fresh')
    const warm = samples.filter(row => row.phase === phase && row.cache === 'warm')
    const metrics = ['ms', 'statements', 'hit', 'read', 'rowsWritten', 'wal'].map(key => `${number(mean(fresh, key))} / ${number(mean(warm, key))}`)
    lines.push(`| ${phase} | ${metrics.join(' | ')} |`)
  }
  const comparisons = ['fresh', 'warm'].map(cache => {
    const result = comparePairs(samples.filter(row => row.cache === cache))
    return `${cache}: gain ${number(result.gain)} ms; noise ${number(result.noise)} ms; ${result.keep ? 'beyond noise' : 'within noise'}`
  })
  const followup = samples.filter(row => row.phase === 'candidate').map(row => row.followup)
  const counts = ['work', 'forecast', 'live', 'requests'].map(key => {
    const values = followup.map(row => row[key])
    return `${key} ${Math.min(...values)}–${Math.max(...values)}`
  })
  lines.push('', `${comparisons.join('. ')}.`, '', `Follow-up counts: ${counts.join(', ')}.`, '')
}
const result = { version: 1, project: 'pt4bafablel7', ports: '648xx', limits: { cpus: stack.limits.NanoCpus / 1e9, memory: stack.limits.Memory },
  settings: stack.settings, backupHashes: stack.hashes, backupRows: stack.backupRows, tupleHash: stack.tupleHash,
  verification: read('verification'), experiments }
writeFileSync(evidencePath('pipeline-night-results.json'), `${JSON.stringify(result, null, 2)}\n`)
writeFileSync(evidencePath('pipeline-night-tables.md'), `${lines.join('\n')}\n`)
process.stdout.write(`${cases.length} cases; ${final.samples.length} final samples; ${experiments.reduce((sum, row) => sum + row.samples.length, 0)} total samples.\n`)

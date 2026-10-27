import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { officialReplay, officialReplayStart } from './official-replay.mjs'

const bounds = { firstStart: '2024-10-22', firstEnd: '2025-04-13' }

test('official starts accept week boundaries and midweek dates only with late-season authorization', async () => {
  assert.equal(officialReplayStart({}, bounds), bounds.firstStart)
  for (const start of ['2025-02-10', '2025-02-12', bounds.firstStart, bounds.firstEnd]) {
    assert.equal(officialReplayStart({ 'late-season': true, start }, bounds), start)
    assert.throws(() => officialReplayStart({ start }, bounds), /--late-season or a saved checkpoint/)
    assert.throws(() => officialReplayStart({ 'late-season': 'true', start }, bounds), /--late-season or a saved checkpoint/)
  }
  await assert.rejects(officialReplay({ start: '2025-02-10' }, {}), /--late-season or a saved checkpoint/)
})

test('official starts reject invalid dates and preserve saved continuation dates', () => {
  for (const start of ['2025-02-30', '2025-01-32', '2024-10-21', '2025-04-14', 'invalid']) {
    assert.throws(() => officialReplayStart({ 'late-season': true, start }, bounds))
  }
  assert.equal(officialReplayStart({ start: '2025-02-10', resume: { date: '2025-06-01' } }, bounds), '2025-06-01')
})

test('official replay wires late starts into the runtime, league, waivers, and deadline actions', () => {
  for (const start of [null, '2025-02-10', '2025-02-12']) {
    const replacements = {
      'node:fs/promises': `export const chmod = async () => {}; export const readFile = async () => { throw new Error('Unexpected file read') }`,
      './official-inputs.mjs': `export const officialInputs = async () => ({ bounds: { firstStart: '2024-10-22', firstEnd: '2025-04-13', checkpoint: '2025-02-10', secondThrough: '2025-11-03' }, seasons: [{ year: 2025, calendar: { weeks: [{ week_number: 17, week_start: '2025-02-10', week_end: '2025-02-23' }] } }], games: [], draft: {} })`,
      './official-runtime.mjs': `export const officialRuntime = async at => { events.push({ kind: 'runtime', at }); let clock = Date.parse(at); return { keys: {}, origin: {}, now: () => clock, move: async at => { clock = typeof at === 'number' ? at : Date.parse(at) }, verifyFidelity: async () => {}, close: async () => {} } }`,
      './actions.mjs': `export const actionClient = () => ({}); export const createLeagueActions = async (_, date, count, options) => { events.push({ kind: 'league', date, count, skipPastWeeks: options.skipPastWeeks, settings: options.scenario.settings }); return { leagueId: 'league', leagueSeasonId: 'season', seasonYear: 2025, users: Array.from({ length: count }, (_, memberId) => ({ memberId })), skippedWeeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], rest: async () => Array.from({ length: count }, () => ({ enabled: true })) } }`,
      './common.mjs': `export const season = { year: 2025 }; export const miniRoot = '/scratch'; export const dates = start => [start]; export const etDate = value => value.slice(0, 10); export const laneDirectory = async () => {}; export const writeJson = async () => {}`,
      './local-stack.mjs': `export const sql = async () => '5'; export const sqlJson = async (_, label) => label === 'Official fresh database' ? { leagues: 0, rosters: 0 } : label === 'Official current season' ? { id: 'season' } : {}`,
      './live-checks.mjs': `export const assertClientScores = async () => ({ observations: {}, matchups: [1, 2, 3, 4, 5] }); export const assertClosedWeeks = async () => []`,
      './assertions.mjs': `export const assertFinals = async () => ({})`,
      './checkpoints.mjs': `export const saveSnapshot = async () => { throw new Error('Unexpected snapshot') }; export const waitForSnapshotWorkers = async () => {}`,
      './source-manifest.mjs': `export const sourceEvidence = async () => ({ harness: { sha256: 'fixed' }, application: {} })`,
      './official-report.mjs': `export const summarizeOfficial = () => ({ fullAcceptance: false, gaps: [] })`,
      './official-forecast.mjs': `export const captureOfficialForecasts = async () => {}; export const scoreOfficialForecasts = async () => {}`,
      './official-trades.mjs': `export const advanceOfficialTrades = async (_, date) => events.push({ kind: 'trade', date }); export const auditOfficialTradeValues = async () => {}; export const recordPostTradeScoring = async () => {}`,
      './official-lifecycle.mjs': `export const observeOfficialChampion = async () => {}; export const verifyOfficialRollover = async () => {}; export const runOfficialRookieDraft = async () => {}`,
      './official-waivers.mjs': `export const beginOfficialWaivers = async () => events.push({ kind: 'waivers' }); export const verifyOfficialWaivers = async () => {}`,
      './calendar-oracle.mjs': `export const checkCalendar = () => ({ passed: true })`,
      './realtime-probe.mjs': `export const startRealtimeProbe = async () => { events.push({ kind: 'realtime' }); return { events: [], close: async () => events.push({ kind: 'close-realtime' }) } }`,
    }
    const options = start ? { start, 'late-season': true } : {}
    const program = `
      import { registerHooks } from 'node:module';
      globalThis.events = [];
      const replacements = ${JSON.stringify(replacements)};
      registerHooks({ resolve(specifier, context, next) {
        return replacements[specifier] ? { url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true } : next(specifier, context);
      } });
      const { officialReplay } = await import(${JSON.stringify(new URL('./official-replay.mjs', import.meta.url).href)});
      const report = await officialReplay(${JSON.stringify(options)}, { profile: { firstYear: 2025, teamCount: 10, settings: { skipped_weeks: [1] } } });
      console.log(JSON.stringify({ events, lateStart: report.lateStart ?? null, snapshots: report.snapshots, complete: report.complete }));
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', env: { ...process.env, SEASON_SIM_MODE: 'two-season' } })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout)
    const date = start ?? '2024-10-22'
    assert.deepEqual(result.events[0], { kind: 'runtime', at: `${date}T09:59:00Z` })
    assert.deepEqual(result.events[1], { kind: 'league', date, count: 10, skipPastWeeks: Boolean(start), settings: { skipped_weeks: [1] } })
    assert.ok(result.events.some(event => event.kind === 'trade' && event.date === date))
    assert.equal(result.events.some(event => event.kind === 'waivers'), Boolean(start))
    assert.equal(result.events.some(event => event.kind === 'realtime'), Boolean(start))
    assert.equal(result.events.some(event => event.kind === 'close-realtime'), Boolean(start))
    assert.equal(result.lateStart?.start ?? null, start)
    assert.deepEqual(result.snapshots, [])
    assert.equal(result.complete, true)
  }
})

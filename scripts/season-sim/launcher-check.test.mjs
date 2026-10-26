import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { launcherCheck, launcherStart, lateSeasonCheck } from './launcher-check.mjs'

test('bounded launcher checks require both snapshots through October 27', () => {
  assert.equal(launcherCheck({}), null)
  assert.equal(launcherCheck({ 'check-first-date': true }).days, 1)
  const check = launcherCheck({ 'check-through': '2025-10-27' })
  assert.equal(check.days, 7)
  assert.equal(check.dates.at(-1), '2025-10-27')
  assert.deepEqual(check.snapshots, ['waiver-week', 'live-week'])
})

test('bounded launcher checks reject conflicting modes and dates beyond their limit', () => {
  assert.throws(() => launcherCheck({ 'check-first-date': true, 'check-through': '2025-10-27' }), /Choose one/)
  for (const through of ['2025-10-20', '2025-10-28', '2026-02-30', 'invalid']) assert.throws(() => launcherCheck({ 'check-through': through }))
})

test('late launcher starts accept real dates and reject bounded checks', () => {
  assert.equal(launcherStart({}), null)
  assert.deepEqual(launcherStart({ start: '2025-02-10' }), { 'late-season': true, start: '2025-02-10' })
  assert.deepEqual(launcherStart({ start: '2025-02-12' }), { 'late-season': true, start: '2025-02-12' })
  for (const start of ['invalid', '2025-2-10', '2025-02-30']) assert.throws(() => launcherStart({ start }))
  for (const check of [{ 'check-first-date': true }, { 'check-through': '2025-10-27' }]) {
    assert.throws(() => launcherCheck({ ...check, start: '2025-02-10' }), /Choose --start/)
  }
})

test('late launcher requires completed acceptance with no failures', () => {
  const result = { complete: true, invariantFailures: 0, failures: [], gates: { noFailure: true }, fullAcceptance: false, lateStart: { start: '2025-02-10', passed: true, notMeasured: ['forecastCalibration'], gaps: [] } }
  assert.deepEqual(lateSeasonCheck(result), { passed: true, complete: true, invariantFailures: 0, failures: [], lateStart: result.lateStart })
  for (const change of [
    { complete: false }, { invariantFailures: 1 }, { failures: [{ message: 'failure' }] }, { error: 'failed' }, { cleanupError: 'failed' }, { failure: 'failed' },
    { gates: { noFailure: false } }, { fullAcceptance: true }, { lateStart: { ...result.lateStart, passed: false } }, { lateStart: { ...result.lateStart, gaps: ['deadline'] } },
  ]) assert.throws(() => lateSeasonCheck({ ...result, ...change }))
})

test('fresh launcher preserves full and bounded modes and records late acceptance', () => {
  for (const mode of ['full', 'bounded', 'late', 'late-failed']) {
    const late = mode.startsWith('late')
    const source = { committedHarness: true, application: { commit: 'a'.repeat(40), archiveSha256: 'archive' } }
    const result = late
      ? { complete: true, invariantFailures: 0, failures: [], gates: { noFailure: true }, fullAcceptance: false, lateStart: { start: '2025-02-10', passed: mode === 'late', notMeasured: ['forecastCalibration'], gaps: mode === 'late' ? [] : ['deadline'] } }
      : { complete: true, invariantFailures: 0, fullAcceptance: mode === 'full', completedDates: 1, freshDatabase: true, verifiedGames: 1 }
    const args = ['--source-sha', source.application.commit, ...(late ? ['--start', '2025-02-10'] : mode === 'bounded' ? ['--check-first-date'] : [])]
    const replacements = {
      'node:child_process': `export const execFileSync = (...args) => events.push({ kind: 'command', args: args.slice(0, 2) })`,
      'node:fs/promises': `export const readFile = async file => file.endsWith('final-run.json') ? JSON.stringify(result) : 'BEGIN;'; export const mkdir = async () => {}; export const realpath = async () => '/scratch/repo'; export const rename = async () => {}; export const stat = async () => ({ size: 1 })`,
      './common.mjs': `export const config = { snapshots: '/scratch/snapshots', cli: 'fake-supabase', project: 'fake' }; export const fixtureDirectory = '/scratch/fixtures'; export const miniRoot = '/scratch'; export const season = { year: 2025, start: '2024-10-22', end: '2025-04-13' }; export const sha256 = () => 'archive'; export const dates = (start, end) => Array.from({ length: (Date.parse(end) - Date.parse(start)) / 86400000 + 1 }, (_, index) => new Date(Date.parse(start) + index * 86400000).toISOString().slice(0, 10)); export const writeJson = async (file, value) => { files[file.split('/').at(-1)] = value }`,
      './source-manifest.mjs': `export const sourceEvidence = async () => (${JSON.stringify(source)})`,
      './local-stack.mjs': `export const clearOwnBackup = async () => true; export const localKeys = () => ({ DB_URL: 'local' }); export const setupStack = async () => events.push({ kind: 'setup' }); export const sql = async () => {}`,
      './replay.mjs': `export const replay = async options => events.push({ kind: 'replay', options })`,
    }
    const program = `
      import { registerHooks } from 'node:module';
      globalThis.events = []; globalThis.files = {}; globalThis.result = ${JSON.stringify(result)};
      process.argv = [process.execPath, ...${JSON.stringify(args)}];
      const replacements = ${JSON.stringify(replacements)};
      registerHooks({ resolve(specifier, context, next) {
        return replacements[specifier] ? { url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true } : next(specifier, context);
      } });
      await import(${JSON.stringify(new URL('./fresh-run.mjs', import.meta.url).href)});
      console.log(JSON.stringify({ events, files }));
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', env: { ...process.env, SEASON_SIM_MODE: 'two-season', SEASON_SIM_PROFILE: '/scratch/profile.json' } })
    assert.equal(child.status, mode === 'late-failed' ? 1 : 0, child.stderr)
    const proof = JSON.parse(child.stdout)
    assert.deepEqual(proof.events.find(event => event.kind === 'replay').options, late ? { 'late-season': true, start: '2025-02-10' } : mode === 'bounded' ? { days: 1 } : {})
    assert.equal(proof.files['exit.json'].exit, mode === 'late-failed' ? 1 : 0)
    assert.equal(proof.files['exit.json'].cleanup.clockRestored, true)
    assert.equal(proof.files['exit.json'].cleanup.stackStopped, true)
    if (late) assert.equal(proof.files['launch.json'].mode, 'Late-season official replay from 2025-02-10')
    if (mode === 'late') assert.equal(proof.files['late-season-check.json'].lateStart.passed, true)
    if (mode === 'late-failed') assert.match(proof.files['launch-failure.json'].message, /measurable acceptance/)
    if (mode === 'bounded') assert.equal(proof.files['official-launcher-check.json'].passed, true)
    if (mode === 'full') assert.equal(proof.files['launch.json'].mode, 'Fresh real two-season replay')
  }
})

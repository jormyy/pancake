// F7 compact-UI browser mutants (card t_4ba51e0d common-t10 protocol). Each mutant edits
// components/settings/NotificationSettings.tsx in this disposable checkout, builds the release web bundle, serves it with
// the local API router and runs tests/e2e/notification-collapsed-tap.mjs in WebKit and Chromium. The unmutated build must
// pass first; the source is restored and hash-verified after every mutant, and a final rebuild must reproduce the
// baseline bundle digest. Never run this in a checkout whose changes could be committed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const file = 'components/settings/NotificationSettings.tsx'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const mutants = [
  { id: 'F7-M1', operator: 'category expand/collapse handler becomes a no-op',
    original: 'onPress={() => setExpanded(current => ({ ...current, [category]: !current[category] }))}',
    mutated: 'onPress={() => setExpanded(current => current)}' },
  { id: 'F7-M2', operator: 'event switch writes the category key instead of its event_settings key',
    original: 'onPress={() => onChange(current => ({ ...current, events: { ...current.events, [event.key]: !eventEnabled(current, event.key) } }))}',
    mutated: 'onPress={() => onChange(current => ({ ...current, events: { ...current.events, [event.category]: !eventEnabled(current, event.key) } }))}' },
]
// A kill needs a flow that reached the notification panel and then failed on expansion, the toggle or persistence.
const behavioral = failure => /^(expand-|toggle-)/.test(failure.step ?? '') || /Exactly the tapped|notification_preferences|shows the stored preference/.test(failure.error)

export async function runF7Browser({ baseSha, evidence, stack, lane = 'claude-gaps' }) {
  assert.match(baseSha ?? '', /^[0-9a-f]{40}$/, 'Pass the measured checkout SHA')
  const { keys, ports } = stack
  const web = `${ports.api.slice(0, 3)}80`, apiProxy = `${ports.api.slice(0, 3)}81`
  mkdirSync(join(evidence, 'logs'), { recursive: true })
  const record = entry => { appendFileSync(join(evidence, 'commands.jsonl'), JSON.stringify({ ...entry, baseSha }) + '\n'); console.log(JSON.stringify(entry)) }
  const step = (label, command, env = {}) => {
    const started = performance.now()
    const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 })
    const log = join(evidence, 'logs', `${label}.log`)
    writeFileSync(log, `$ ${command.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
    const entry = { label, command: command.join(' '), exit: result.status ?? 124, seconds: Number(((performance.now() - started) / 1000).toFixed(1)), log: relative(evidence, log) }
    record(entry)
    return entry
  }
  const children = []
  const launch = (name, command, env) => {
    const child = spawn(command[0], command.slice(1), { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', openSync(join(evidence, 'logs', `${name}.log`), 'a'), openSync(join(evidence, 'logs', `${name}.log`), 'a')] })
    children.push(child)
    return child
  }
  const waitFor = async url => {
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(url)).ok) return } catch { /* still starting */ }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw Error(`${url} did not start`)
  }
  const build = label => {
    mkdirSync('.tmp/f7-metro', { recursive: true })
    const entry = step(`${label}-build`, ['npm', 'run', 'build:web:release'], { npm_config_userconfig: '/dev/null', HUSKY: '0', EXPO_NO_DOTENV: '1',
      TMPDIR: `${process.cwd()}/.tmp/f7-metro`, EXPO_PUBLIC_SUPABASE_URL: keys.API_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keys.ANON_KEY,
      EXPO_PUBLIC_API_URL: `${keys.API_URL}/functions/v1/api`, PANCAKE_RELEASE_SHA: baseSha })
    assert.equal(entry.exit, 0, `${label} release build must succeed`)
    return JSON.parse(readFileSync('dist/release-provenance.json', 'utf8')).bundleDigest
  }
  const oracleArgs = label => ['node', 'tests/e2e/notification-collapsed-tap.mjs', `--frontend-url=http://127.0.0.1:${web}`, `--api-url=${keys.API_URL}`,
    `--api-proxy-port=${apiProxy}`, `--db-port=${ports.db}`, `--build-sha=${baseSha}`, `--run=${label}`]
  const oracle = async label => {
    const server = launch(`${label}-web`, ['node', 'tests/e2e/static-web-server.mjs', `--port=${web}`, '--host=127.0.0.1'])
    try {
      await waitFor(`http://127.0.0.1:${web}/release-provenance.json`)
      const directory = join(evidence, 'f7', label)
      const entry = step(`${label}-tap`, oracleArgs(label), { NOTIFICATION_TAP_EVIDENCE: directory, NOTIFICATION_TAP_FAIL_FAST: '1' })
      const report = existsSync(join(directory, 'report.json')) ? JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) : null
      return { ...entry, report, reportPath: relative(evidence, join(directory, 'report.json')) }
    } finally { server.kill('SIGTERM') }
  }
  const source = readFileSync(file, 'utf8')
  const digest = sha256(source)
  const rows = []
  try {
    launch('api', ['deno', 'eval', '--no-check', `import { handleApiRoute } from './supabase/functions/api/router.ts'; Deno.serve({hostname:'127.0.0.1',port:${apiProxy}},handleApiRoute)`],
      { SUPABASE_URL: keys.API_URL, PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: keys.ANON_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token' })
    await waitFor(`http://127.0.0.1:${apiProxy}/functions/v1/api/health`)
    const baselineDigest = build('baseline')
    const baseline = await oracle('baseline')
    assert.equal(baseline.exit, 0, 'The unmutated release build must pass the tap runner before any mutant')
    assert.ok(baseline.report?.engines.length === 2 && baseline.report.engines.every(engine => engine.status === 'PASS'))
    for (const mutant of mutants) {
      assert.equal(source.split(mutant.original).length - 1, 1, `${mutant.id} target must occur once`)
      let check, bundleDigest
      try {
        writeFileSync(file, source.replace(mutant.original, mutant.mutated))
        bundleDigest = build(mutant.id)
        check = await oracle(mutant.id)
      } finally {
        writeFileSync(file, source)
        assert.equal(sha256(readFileSync(file, 'utf8')), digest, `Restore of ${mutant.id} must match`)
      }
      const failures = (check.report?.engines ?? []).map(engine => ({ engine: engine.engine, status: engine.status, ...engine.failures[0] }))
      const killers = failures.filter(failure => failure.status === 'FAIL' && failure.error && behavioral(failure))
      const outcome = check.exit === 0 ? 'survived' : killers.length ? 'killed' : 'invalid'
      const reason = outcome === 'killed'
        ? `behavioral failure in ${killers.map(failure => `${failure.engine} at ${failure.step} (${failure.category}/${failure.position}/${failure.route}): ${failure.error.split('\n')[0]}; stored event_settings ${JSON.stringify(failure.storedAtFailure?.event_settings ?? null)}`).join(' | ')}`
        : outcome === 'survived' ? 'tap runner passes in both engines' : `runner failed outside a behavioral step: ${JSON.stringify(failures).slice(0, 400)}`
      const row = { id: mutant.id, lane, area: 'F7 compact UI', file, line: source.slice(0, source.indexOf(mutant.original)).split('\n').length, symbol: 'NotificationSettings',
        operator: mutant.operator, original: mutant.original, mutated: mutant.mutated, base_sha: baseSha, prior_sha: null, prior_outcome: null, applied: true, outcome, reason,
        oracle_kind: 'browser', oracle_cmds: [`NOTIFICATION_TAP_FAIL_FAST=1 ${oracleArgs(mutant.id).join(' ')} (release web build of the mutated checkout; WebKit and Chromium)`],
        baseline_exit: baseline.exit, mutant_exit: check.exit, seconds: check.seconds, log: check.log, restore_sha256: digest,
        notes: `baseline bundle ${baselineDigest}; mutant bundle ${bundleDigest}; report ${check.reportPath}` }
      rows.push(row)
      appendFileSync(join(evidence, 'results.jsonl'), JSON.stringify(row) + '\n')
      console.log(JSON.stringify({ id: row.id, outcome, reason }))
    }
    const restoredDigest = build('restored')
    record({ label: 'restored-bundle', baselineDigest, restoredDigest, match: restoredDigest === baselineDigest })
    assert.equal(restoredDigest, baselineDigest, 'The restored checkout must rebuild the baseline bundle')
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  }
  return rows
}

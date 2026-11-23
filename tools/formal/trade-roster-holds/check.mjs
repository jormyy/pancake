#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const coverage = JSON.parse(readFileSync(path.join(here, 'coverage.json'), 'utf8'))
const tlc = coverage.tlc
const jar = process.env.TLA2TOOLS ?? path.join(homedir(), '.cache/pancake-formal', `tla2tools-${tlc.version}`, 'tla2tools.jar')
const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const migrationDir = path.join(repo, coverage.migrations.dir)
const migrationSet = (through) => {
  const hash = createHash('sha256')
  for (const name of readdirSync(migrationDir).filter((name) => name.endsWith('.sql') && name <= through).sort()) {
    hash.update(`${name}\0${createHash('sha256').update(readFileSync(path.join(migrationDir, name))).digest('hex')}\n`)
  }
  return hash.digest('hex')
}
const migrationNames = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()

if (process.argv.includes('--record-migrations')) {
  const through = migrationNames.at(-1)
  writeFileSync(path.join(here, 'coverage.json'), `${JSON.stringify({ ...coverage, migrations: { ...coverage.migrations, through, sha256: migrationSet(through) } }, null, 2)}\n`)
  console.log(`Recorded ${migrationNames.length} migrations through ${through}.`)
  process.exit(0)
}

const newer = migrationNames.filter((name) => name > coverage.migrations.through)
const reviewedChanged = migrationSet(coverage.migrations.through) !== coverage.migrations.sha256
if (newer.length || reviewedChanged) {
  fail(
    [
      `Migration SQL in ${coverage.migrations.dir} differs from the set reviewed for this model, which ends at ${coverage.migrations.through}.`,
      ...newer.map((name) => `  new: ${name}`),
      ...(reviewedChanged ? [`  a migration at or before ${coverage.migrations.through} was edited, removed or added out of order; see git status and git diff ${coverage.syncCommit} -- ${coverage.migrations.dir}`] : []),
      'A migration can change trade holds, waiver claims or roster capacity without touching the by-name sources. Review each listed file against the Model table in .claude/skills/formal-trade-roster-holds/SKILL.md.',
      'If it changes what the model describes, update the model and the replay in the same change. Either way, rerun with --record-migrations, then run this check again.',
    ].join('\n'),
  )
}

if (spawnSync('git', ['cat-file', '-e', `${coverage.syncCommit}^{commit}`], { cwd: repo }).status !== 0) {
  fail(`This clone lacks syncCommit ${coverage.syncCommit}, so covered files cannot be compared. Fetch it with git fetch origin ${coverage.syncCommit} or git fetch --unshallow.`)
}

if (process.argv.includes('--install') && !existsSync(jar)) {
  mkdirSync(path.dirname(jar), { recursive: true })
  const response = await fetch(tlc.url)
  if (!response.ok) fail(`TLC download failed: ${response.status}`)
  writeFileSync(jar, Buffer.from(await response.arrayBuffer()))
}
if (!existsSync(jar)) fail(`TLC ${tlc.version} is missing at ${jar}. Rerun with --install, or set TLA2TOOLS.`)
const digest = createHash('sha256').update(readFileSync(jar)).digest('hex')
if (digest !== tlc.sha256) fail(`${jar} has sha256 ${digest}; expected TLC ${tlc.version} ${tlc.sha256}.`)

const java = [process.env.JAVA, 'java', '/opt/homebrew/opt/openjdk@21/bin/java', '/opt/homebrew/opt/openjdk/bin/java']
  .filter(Boolean)
  .find((candidate) => spawnSync(candidate, ['-version']).status === 0)
if (!java) fail('Java 11 or later is required. Set JAVA to a java binary.')

const changed = execFileSync('git', ['diff', '--name-only', coverage.syncCommit, '--', ...coverage.files], { cwd: repo, encoding: 'utf8' }).trim()
if (changed) fail(`Covered code changed since ${coverage.syncCommit}. Recheck the model against:\n${changed}\nThen move syncCommit in coverage.json.`)

const steps = {
  TeamProposes: 'the team sends an offer, which counts as its yes',
  TeamAccepts: 'the team accepts an offer',
  TeamWithdraws: 'the team withdraws its acceptance',
  PartnerFinalYes: 'the last partner says yes and the trade is unanimous',
  PartnerDeclines: 'a partner declines the offer',
  TradeCompletes: 'the unanimous trade completes',
  TeamEntersClaim: 'the team enters a waiver claim',
  WaiversRun: 'waivers run on that claim',
  TeamDropsPlayer: 'the team drops a player',
}

const offers = (text) => Object.fromEntries([...text.matchAll(/(\w+) :> "?(\w+)"?/g)].map((hit) => [hit[1], hit[2]]))

const story = (output, rosterSize) =>
  output
    .split(/\n(?=State \d+:)/)
    .filter((block) => block.startsWith('State '))
    .map((block) => {
      const [, number, action] = block.match(/^State (\d+): <(\w+)/)
      const value = (name) => block.match(new RegExp(`/\\\\ ${name} = (.*)`))[1]
      const held = offers(value('held'))
      const trades = Object.entries(offers(value('status')))
        .map(([offer, status]) => `${offer} ${status}${held[offer] === 'TRUE' && status === 'pending' ? ' and accepted by the team' : ''}`)
        .join(', ')
      const step = action === 'Initial' ? 'start' : steps[action] ?? action
      return `  ${number}. ${step}. Roster ${value('active')} of ${rosterSize}; ${trades}; waiver claim ${value('claim').replaceAll('"', '')}.`
    })
    .join('\n')

const scratch = mkdtempSync(path.join(tmpdir(), 'pancake-trade-holds-'))
let failed = false
try {
  for (const run of coverage.runs) {
    const result = spawnSync(
      java,
      [`-Djava.io.tmpdir=${scratch}`, '-cp', jar, 'tlc2.TLC', '-workers', '1', '-metadir', path.join(scratch, run.config), '-config', `${run.config}.cfg`, 'TradeRosterHolds.tla'],
      { cwd: here, encoding: 'utf8' },
    )
    const output = `${result.stdout}${result.stderr}`
    const violated = output.match(/Invariant (\w+) is violated/)?.[1] ?? null
    const passed = result.status === 0 && output.includes('No error has been found')
    const states = output.match(/(\d+) distinct states found/)?.[1]
    const taken = [...output.matchAll(/^State \d+: <(\w+)/gm)].map((hit) => hit[1]).slice(1)
    const ok = run.expect === 'pass' ? passed : violated === run.expect && (run.path ? taken.join() === run.path.join() : taken.at(-1) === run.through)
    failed ||= !ok
    const expected = run.path ? `after exactly: ${run.path.map((action) => steps[action]).join(', then ')}` : `at ${steps[run.through]}`
    console.log(`${ok ? 'ok' : 'FAIL'} ${run.config}: ${passed ? `no violation in ${states} states` : violated ? `${violated} violated` : 'TLC error'} (expected ${run.expect === 'pass' ? 'no violation' : `${run.expect} violated ${expected}`})`)
    if (violated) console.log(story(output, readFileSync(path.join(here, `${run.config}.cfg`), 'utf8').match(/RosterSize = (\d+)/)[1]))
    if (!passed && !violated) console.log(output)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

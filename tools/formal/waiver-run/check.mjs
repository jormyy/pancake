#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
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

const fixes = {
  AwardFollowsWaiverOrder:
    'A run must award, across the whole league, the pending claim with the earliest process_date, then the highest FAAB bid, then the best rolling priority, then the team claim_order. Fix: in process_next_waiver_claim_atomic, pick the winner from every pending claim in the league with ORDER BY wc.process_date ASC, bid_amount DESC, wp.priority ASC, wc.claim_order ASC. Do not pick a player first.',
  NoWaitWhileHoldingAnotherLeague:
    'A batch runs in one transaction, so a blocking lock taken after an earlier award stalls every league that batch holds. Fix: take team and player locks with pg_try_advisory_xact_lock, raise PW001 when one is busy, and CONTINUE so the subtransaction releases the attempt. Never call pg_advisory_xact_lock inside the batch.',
  PlayerAwardedOnce: 'Fix: mark every other pending claim for the player lost in the same subtransaction as the award, under the player lock.',
  WinnerOwnsPlayer: 'Fix: insert the roster row in the same subtransaction that marks the claim succeeded.',
  FaabSpentOnlyOnWins: 'Fix: deduct FAAB only on the success path, in the same subtransaction as the roster insert.',
  TypeOK: 'The model reached a state outside its types. Fix the model, not the SQL.',
}

const source = path.join(repo, coverage.source.dir)
const header = `FUNCTION ${coverage.source.function}(`
const migration = readdirSync(source)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .filter((name) => readFileSync(path.join(source, name), 'utf8').includes(header))
  .at(-1)
if (!migration) fail(`No migration in ${coverage.source.dir} defines ${coverage.source.function}.`)
const sql = readFileSync(path.join(source, migration), 'utf8')
const start = sql.lastIndexOf(header)
const body = sql.slice(start, sql.indexOf('\n$$;', start))
const unknown = (what) =>
  fail(
    `${migration} changed how ${coverage.source.function} ${what}. The waiver run model in ${path.relative(repo, here)} no longer knows this shape. Map the new SQL onto WaiverRun.tla Order and Locking, or add a variant there, then rerun this check.`,
  )

const winner = body.match(/SELECT wc\.\*\s+INTO v_claim([\s\S]*?)LIMIT 1/)?.[1] ?? unknown('selects the winning claim')
const keyOf = (line) =>
  [
    [/process_date( ASC)?$/, 'run'],
    [/bid_amount END DESC/, 'bid'],
    [/priority ASC$/, 'priority'],
    [/claim_order ASC$/, 'order'],
    [/player_id$/, 'player'],
    [/submitted_at ASC$|\.id ASC$|\.league_id$|\.league_season_id$/, null],
  ].find(([pattern]) => pattern.test(line))
const orderKeys = (text) =>
  text
    .split(',')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => keyOf(line) ?? unknown(`orders claims (${line})`))
    .map(([, key]) => key)
    .filter(Boolean)
    .join(' ')
const winnerKeys = orderKeys(winner.split('ORDER BY')[1] ?? unknown('orders the winning claim'))
const candidates = body.match(/FOR v_candidate IN([\s\S]*?)\n\s*LOOP/)?.[1] ?? ''
const scoped = /wc\.player_id = v_\w+(\.player_id)?\b/.test(winner)
const candidateKeys = scoped ? orderKeys(candidates.split('ORDER BY').at(-1).replace(/\s*LIMIT \d+\s*$/, '')) : ''
const order =
  scoped && candidateKeys === 'run player'
    ? 'player-then-bid-priority-order'
    : { 'run bid priority order': 'run-bid-priority-order', 'bid priority order': 'bid-priority-order' }[scoped ? candidateKeys : winnerKeys]
if (!order || (scoped && winnerKeys !== 'bid priority order')) unknown(`orders claims (${scoped ? `candidates by ${candidateKeys}, then ` : ''}winner by ${winnerKeys})`)
const locking = /PERFORM pg_advisory_xact_lock\(/.test(body)
  ? 'block-after-league'
  : /pg_try_advisory_xact_lock\(hashtext\(v_claim\.league_id::text\), hashtext\(v_claim\.member_id::text\)\)/.test(body) &&
      /WHEN SQLSTATE 'PW001'[\s\S]*?CONTINUE;/.test(body)
    ? 'try-defer'
    : unknown('locks the team and players')

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

const steps = {
  BeginBatch: 'starts a batch transaction',
  TryLeague: 'try-locks the league and picks its next claim',
  TakeLock: 'locks',
  BlockOnBusyLock: 'blocks on a lock another transaction holds',
  DeferBusyAttempt: 'finds a lock busy and rolls back the attempt',
  ResolveLocked: 'settles the claim',
  CommitBatch: 'commits the batch',
  AbortBatch: 'aborts the batch and rolls back',
  MutationBegins: 'a roster move locks',
  MutationEnds: 'a roster move finishes',
}

const variables = (block) =>
  Object.fromEntries(
    block
      .split(/\n(?=\/\\ )/)
      .slice(1)
      .map((part) => part.match(/^\/\\ (\w+) = ([\s\S]*)$/))
      .filter(Boolean)
      .map(([, name, value]) => [name, value]),
  )
const statuses = (vars) => Object.fromEntries([...(vars.status ?? '').matchAll(/(c\d) \|-> "(\w+)"/g)].map((hit) => [hit[1], hit[2]]))
const holders = (vars) => Object.fromEntries([...(vars.held ?? '').matchAll(/<<"(\w+)", "(\w+)">> :> "?(\w+)"?/g)].map((hit) => [`${hit[1]} ${hit[2]}`, hit[3]]))

const story = (output) => {
  let before = {}
  return output
    .split(/\n(?=State \d+:)/)
    .filter((block) => block.startsWith('State '))
    .map((block) => {
      const [, number, action] = block.match(/^State (\d+): <(\w+)/)
      const vars = variables(block)
      const changed = Object.entries(statuses(vars)).filter(([claim, value]) => statuses(before)[claim] !== value)
      const taken = Object.entries(holders(vars)).filter(([lock, who]) => who !== 'none' && holders(before)[lock] !== who)
      const freed = Object.entries(holders(vars)).filter(([lock, who]) => who === 'none' && holders(before)[lock] && holders(before)[lock] !== 'none')
      const waiting = action === 'BlockOnBusyLock' ? [...(vars.pc ?? '').matchAll(/(w\d) :> "wait"/g)].map((hit) => hit[1]) : []
      const facts = [
        ...waiting.map(
          (worker) =>
            `${worker} waits while it holds ${Object.entries(holders(vars))
              .filter(([lock, who]) => who === worker && lock.startsWith('league'))
              .map(([lock]) => lock)
              .join(' and ')}`,
        ),
        ...changed.map(([claim, value]) => `${claim} ${value}`),
        ...taken.map(([lock, who]) => `${who} holds ${lock}`),
        ...freed.map(([lock]) => `${lock} free`),
        ...(vars.passed?.startsWith('<<') && vars.passed !== before.passed ? [`awarded ${vars.passed.match(/"(\w+)", "(\w+)"/).slice(1).join(' ahead of ')}`] : []),
      ]
      before = vars
      return `  ${number}. ${action === 'Initial' ? 'start' : steps[action] ?? action}${facts.length ? `: ${facts.join(', ')}` : ''}.`
    })
    .join('\n')
}

const scratch = mkdtempSync(path.join(tmpdir(), 'pancake-waiver-run-'))
const run = (name, config) => {
  const result = spawnSync(
    java,
    [`-Djava.io.tmpdir=${scratch}`, '-cp', jar, 'tlc2.TLC', '-workers', 'auto', '-deadlock', '-metadir', path.join(scratch, name), '-config', config, 'WaiverRun.tla'],
    { cwd: here, encoding: 'utf8' },
  )
  const output = `${result.stdout}${result.stderr}`
  return {
    output,
    passed: result.status === 0 && output.includes('No error has been found'),
    violated: output.match(/Invariant (\w+) is violated/)?.[1] ?? null,
    states: output.match(/(\d+) distinct states found/)?.[1],
  }
}
const cfg = (constants, invariants) =>
  [
    'CONSTANTS',
    ...Object.entries(constants).map(([name, value]) => `  ${name} = ${value}`),
    '  Workers = {w1, w2}',
    'SPECIFICATION Spec',
    'INVARIANTS',
    ...invariants.map((name) => `  ${name}`),
    '',
  ].join('\n')

let failed = false
try {
  console.log(`${migration}: winner order ${order}, locking ${locking}.`)
  let remaining = coverage.invariants
  for (let round = 0; remaining.length; round++) {
    const config = path.join(scratch, `derived-${round}.cfg`)
    writeFileSync(config, cfg({ Order: `"${order}"`, Locking: `"${locking}"` }, remaining))
    const result = run(`derived-${round}`, config)
    if (result.passed) {
      console.log(`ok current SQL: no violation of ${remaining.join(', ')} in ${result.states} states`)
      break
    }
    failed = true
    if (!result.violated) {
      console.log(result.output)
      break
    }
    console.log(`FAIL current SQL: ${result.violated} violated\n${story(result.output)}\n  ${fixes[result.violated]}`)
    remaining = remaining.filter((name) => name !== result.violated)
  }

  for (const replay of coverage.replays) {
    const result = run(replay.config, path.join('configs', `${replay.config}.cfg`))
    const ok = result.violated === replay.expect
    failed ||= !ok
    console.log(`${ok ? 'ok' : 'FAIL'} replay ${replay.config} (${replay.mistake}): ${result.violated ? `${result.violated} violated` : result.passed ? 'no violation' : 'TLC error'}, expected ${replay.expect}`)
    if (!ok && !result.violated && !result.passed) console.log(result.output)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

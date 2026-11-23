#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extract, readSources } from './extract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const coverage = JSON.parse(readFileSync(path.join(here, 'coverage.json'), 'utf8'))
const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const args = process.argv.slice(2)
const option = (flag) => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args.splice(at, 2)[1]
}
const adhoc = { functions: option('--functions'), triggers: option('--triggers'), through: option('--through') }
const install = args.includes('--install')

const rank = { keyshare: 1, share: 2, nokey: 3, update: 4 }
const clashing = new Set(['keyshare update', 'share nokey', 'share update', 'nokey nokey', 'nokey update', 'update update'])
const sameRows = (a, b) => !a.states || !b.states || a.states.some((state) => b.states.includes(state))
const clash = (a, b) => a.resource === b.resource && sameRows(a, b) && (clashing.has(`${a.mode} ${b.mode}`) || clashing.has(`${b.mode} ${a.mode}`))
const covers = (h, l) =>
  h.resource === l.resource && rank[h.mode] >= rank[l.mode] && ((h.row && h.row === l.row) || !h.states || (l.states && l.states.every((state) => h.states.includes(state))))
const inScope = (lock) => coverage.scope.kinds.includes(lock.kind) && coverage.scope.resources.includes(lock.resource)
const lockKey = (lock) => `${lock.resource}|${lock.states ?? '*'}|${lock.mode}|${lock.wait}`

const lockPaths = (id, steps) => {
  const counts = new Map()
  const last = new Map()
  const end = new Map()
  let order = 0
  const number = (steps) => {
    for (const step of steps) {
      order += 1
      if (step.call) number(step.call)
      if (step.branches) {
        if (step.condition && step.branches.length === 2) {
          counts.set(step.condition, (counts.get(step.condition) ?? 0) + 1)
          last.set(step.condition, order)
        }
        for (const branch of step.branches) number(branch)
      }
      end.set(step, order)
    }
  }
  number(steps)
  const repeated = new Set([...counts].filter(([, count]) => count > 1).map(([condition]) => condition))
  const forget = (state, step) => {
    const kept = Object.entries(state.choices).filter(([condition]) => last.get(condition) > end.get(step))
    return kept.length === Object.keys(state.choices).length ? state : { ...state, choices: Object.fromEntries(kept) }
  }
  const dedupe = (states) => [...new Map(states.map((state) => [`${state.locks.map(lockKey).join(';')}#${state.done}#${state.returned}#${JSON.stringify(state.choices)}`, state])).values()]
  const walk = (steps, states) => {
    for (const step of steps) {
      states = dedupe(states.flatMap((state) => (state.done || state.returned ? [state] : walkStep(step, state))).map((state) => forget(state, step)))
      if (states.length > coverage.maxPathsPerFunction) {
        fail(`${id} has more than ${coverage.maxPathsPerFunction} lock paths. Move its roster locks into one helper call at the top, or raise maxPathsPerFunction in coverage.json.`)
      }
    }
    return states
  }
  const walkStep = (step, state) => {
    if (step.end === 'abort') return [{ ...state, done: true }]
    if (step.end === 'return') return [{ ...state, returned: true }]
    if (step.call) return walk(step.call, [state]).map((inner) => ({ ...inner, returned: false }))
    if (step.branches) {
      const correlated = step.condition && step.branches.length === 2 && repeated.has(step.condition)
      const chosen = correlated ? state.choices[step.condition] : undefined
      return step.branches.flatMap((branch, index) =>
        chosen !== undefined && chosen !== index ? [] : walk(branch, [correlated ? { ...state, choices: { ...state.choices, [step.condition]: index } } : state]),
      )
    }
    if (!inScope(step) || state.locks.some((held) => covers(held, step))) return [state]
    return [{ ...state, locks: [...state.locks, step] }]
  }
  const finals = walk(steps, [{ locks: [], done: false, returned: false, choices: {} }])
  return [...new Map(finals.map((state) => [state.locks.map(lockKey).join(';'), state.locks])).values()].filter((locks) => locks.length > 1)
}

const waitEdges = (locks) => locks.flatMap((lock, index) => (lock.wait ? locks.slice(0, index).filter((held) => held.resource !== lock.resource).map((held) => [held, lock]) : []))

const tla = (value) => (typeof value === 'string' ? JSON.stringify(value) : value ? 'TRUE' : 'FALSE')
const record = (lock) => `[res |-> ${tla(lock.resource)}, states |-> {${(lock.states ?? ['*']).map(tla).join(', ')}}, mode |-> ${tla(lock.mode)}, wait |-> ${tla(lock.wait)}]`

const jar = process.env.TLA2TOOLS ?? path.join(homedir(), '.cache/pancake-formal', `tla2tools-${coverage.tlc.version}`, 'tla2tools.jar')
const java = [process.env.JAVA, 'java', '/opt/homebrew/opt/openjdk@21/bin/java', '/opt/homebrew/opt/openjdk/bin/java']
  .filter(Boolean)
  .find((candidate) => spawnSync(candidate, ['-version']).status === 0)

const prepareTlc = async () => {
  if (install && !existsSync(jar)) {
    mkdirSync(path.dirname(jar), { recursive: true })
    const response = await fetch(coverage.tlc.url)
    if (!response.ok) fail(`TLC download failed: ${response.status}`)
    writeFileSync(jar, Buffer.from(await response.arrayBuffer()))
  }
  if (!existsSync(jar)) fail(`TLC ${coverage.tlc.version} is missing at ${jar}. Rerun with --install, or set TLA2TOOLS.`)
  const digest = createHash('sha256').update(readFileSync(jar)).digest('hex')
  if (digest !== coverage.tlc.sha256) fail(`${jar} has sha256 ${digest}; expected TLC ${coverage.tlc.version} ${coverage.tlc.sha256}.`)
  if (!java) fail('Java 11 or later is required. Set JAVA to a java binary.')
}

const findDeadlocks = (sources) => {
  const functions = extract({ root: repo, ...sources })
  const unique = new Map()
  for (const [id, entry] of Object.entries(functions)) {
    for (const locks of lockPaths(id, entry.steps)) {
      const key = locks.map(lockKey).join(';')
      if (!unique.has(key)) unique.set(key, { locks, edges: waitEdges(locks), functions: [] })
      unique.get(key).functions.push({ id, locks })
    }
  }
  const paths = [...unique.values()]
  const pairs = []
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i; j < paths.length; j += 1) {
      if (paths[i].edges.some(([heldA, wantA]) => paths[j].edges.some(([heldB, wantB]) => clash(wantA, heldB) && clash(wantB, heldA)))) pairs.push([i, j])
    }
  }
  if (!pairs.length) return { modeled: Object.keys(functions).length, paths: paths.length, pairs: 0, states: 0, deadlocks: [] }

  const scratch = mkdtempSync(path.join(tmpdir(), 'pancake-lock-order-'))
  try {
    copyFileSync(path.join(here, 'LockOrder.tla'), path.join(scratch, 'LockOrder.tla'))
    writeFileSync(
      path.join(scratch, 'LockOrderData.tla'),
      [
        '---- MODULE LockOrderData ----',
        `Paths == << ${paths.map((entry) => `<< ${entry.locks.map(record).join(', ')} >>`).join(',\n  ')} >>`,
        `Pairs == { ${pairs.map(([i, j]) => `<<${i + 1}, ${j + 1}>>`).join(', ')} }`,
        '====',
        '',
      ].join('\n'),
    )
    writeFileSync(path.join(scratch, 'LockOrder.cfg'), 'SPECIFICATION Spec\nINVARIANT NoDeadlock\n')
    const result = spawnSync(
      java,
      [`-Djava.io.tmpdir=${scratch}`, '-cp', jar, 'tlc2.TLC', '-workers', '1', '-deadlock', '-continue', '-metadir', path.join(scratch, 'states'), '-config', 'LockOrder.cfg', 'LockOrder.tla'],
      { cwd: scratch, encoding: 'utf8', maxBuffer: 1 << 30 },
    )
    const output = `${result.stdout}${result.stderr}`
    const states = Number(output.match(/(\d+) distinct states found/)?.[1] ?? NaN)
    if (!output.includes('distinct states found') || /Error: (?!Invariant NoDeadlock is violated|The behavior up to this point is)/.test(output)) fail(`TLC failed:\n${output}`)
    const found = new Map()
    for (const block of output.split('Error: Invariant NoDeadlock is violated.').slice(1)) {
      const last = block.split(/\nState \d+: /).at(-1)
      const pair = last.match(/path = <<(\d+), (\d+)>>/)
      const pc = last.match(/pc = <<(\d+), (\d+)>>/)
      if (!pair || !pc) fail(`Unreadable TLC trace:\n${block}`)
      const at = [1, 2].map((side) => Number(pc[side]) - 1)
      const [left, right] = [1, 2].map((side) => paths[Number(pair[side]) - 1].functions)
      for (const a of left) {
        for (const b of right) {
          const sides = [a, b].map((fn, index) => ({ id: fn.id, holds: fn.locks.slice(0, at[index]), wants: fn.locks[at[index]] }))
          const ordered = a.id <= b.id ? sides : [sides[1], sides[0]]
          const names = ordered.map((side) => side.id)
          const key = deadlockKey(names, ordered.map((side) => side.wants.resource))
          if (!found.has(key)) found.set(key, { key, functions: names, sides: ordered })
        }
      }
    }
    return { modeled: Object.keys(functions).length, paths: paths.length, pairs: pairs.length, states, deadlocks: [...found.values()].sort((x, y) => x.key.localeCompare(y.key)) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const deadlockKey = (functions, waits) => `${functions[0]} waits ${waits[0]} <> ${functions[1]} waits ${waits[1]}`

const site = (lock) => lock.via.join(' > ')
const explain = ({ functions, sides }) =>
  [
    `Deadlock: ${functions[0]} and ${functions[1]} can wait on each other.`,
    ...sides.map((side, index) => {
      const holding = side.holds.find((held) => clash(held, sides[1 - index].wants))
      return `  ${functions[index]} holds ${holding.resource}${holding.states ? ` [${holding.states}]` : ''} from ${site(holding)}\n    and waits for ${side.wants.resource}${side.wants.states ? ` [${side.wants.states}]` : ''} at ${site(side.wants)}.`
    }),
    '  Fix: take the draft lock, then team (member) locks, then player locks, all before any roster_players, trades, waiver_claims or drafts row lock, in every function that touches these rows. Use a pg_try_ lock or NOWAIT where you cannot keep that order.',
  ].join('\n')

const ownLockPattern = /\bpg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?\s*\(|\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i

const driftProblems = () => {
  const dir = path.join(repo, coverage.sources.functions)
  const { functions } = readSources({ functions: [dir], triggers: [], root: repo })
  const modeled = extract({ functions: [dir], triggers: [], root: repo })
  const problems = []
  for (const definition of functions.values()) {
    const stripped = definition.body.replace(/'(?:[^']|'')*'/g, "''")
    const raw = ownLockPattern.test(stripped)
    const directLocks = (steps) => steps.some((step) => (step.branches ? step.branches.some(directLocks) : step.via?.length === 1 && step.kind !== 'dml'))
    const seen = directLocks(modeled[definition.id]?.steps ?? [])
    if (raw && !seen) problems.push(`${definition.file}: the body takes a lock, but extract.mjs found none. Teach extract.mjs this lock form so the model covers ${definition.id}.`)
    if (!raw && seen) problems.push(`${definition.file}: extract.mjs found a lock the body does not take. Fix extract.mjs before trusting the model for ${definition.id}.`)
  }
  const files = readdirSync(dir, { recursive: true }).filter((name) => name.endsWith('.sql'))
  const parsed = new Set([...functions.values()].map((definition) => path.relative(dir, path.join(repo, definition.file))))
  for (const file of files) if (!parsed.has(file) && /\bFUNCTION\b/i.test(readFileSync(path.join(dir, file), 'utf8'))) problems.push(`${path.join(coverage.sources.functions, file)}: extract.mjs could not parse this function, so the model skips it.`)
  return problems
}

const report = (label, result) => console.log(`${label}: ${result.modeled} functions, ${result.paths} lock paths, ${result.pairs} candidate pairs, ${result.states || 0} states`)

const family = ({ sides }) =>
  sides
    .map((side) => `${side.wants.resource} at ${side.wants.via.at(-1).replace(/:\d+$/, '')}`)
    .sort()
    .join(' <> ')

const adhocRun = () => {
  const result = findDeadlocks({ root: process.cwd(), functions: [path.resolve(adhoc.functions)], triggers: adhoc.triggers ? [path.resolve(adhoc.triggers)] : [], through: adhoc.through })
  report(adhoc.functions, result)
  for (const deadlock of result.deadlocks) console.log(explain(deadlock))
  console.log(result.deadlocks.length ? `FAIL ${result.deadlocks.length} deadlock(s)` : 'ok no deadlock')
  return result.deadlocks.length > 0
}

const replayRuns = () =>
  coverage.replays
    .map((replay) => {
      const run = (dir) => findDeadlocks({ functions: [path.join(here, dir)], triggers: [path.join(here, dir)] })
      const bad = run(replay.bad)
      const good = run(replay.good)
      const between = (result) => result.deadlocks.filter((deadlock) => replay.deadlock.every((name) => deadlock.functions.some((id) => id.startsWith(`${name}(`))))
      const caught = between(bad)
      const kept = between(good)
      const ok = caught.length > 0 && !kept.length
      console.log(`${ok ? 'ok' : 'FAIL'} replay ${replay.name}: ${replay.badSha} ${caught.length ? 'deadlocks' : 'shows no deadlock'}, fix ${replay.fixSha} ${kept.length ? 'still deadlocks' : 'is clean'} (${replay.deadlock.join(' vs ')})`)
      for (const deadlock of ok ? caught.slice(0, 1) : [...caught, ...kept]) console.log(explain(deadlock))
      return ok
    })
    .every(Boolean)

const liveRun = () => {
  const live = findDeadlocks({ functions: [path.join(repo, coverage.sources.functions)], triggers: coverage.sources.triggers ? [path.join(repo, coverage.sources.triggers)] : [] })
  report(coverage.sources.functions, live)
  if (args.includes('--record-known')) {
    const reasons = new Map(coverage.knownDeadlocks.flatMap((group) => group.deadlocks.map((key) => [key, group.reason])))
    const groups = new Map()
    for (const deadlock of live.deadlocks) {
      const reason = reasons.get(deadlock.key) ?? `UNREVIEWED ${family(deadlock)}`
      groups.set(reason, [...(groups.get(reason) ?? []), deadlock.key])
    }
    const knownDeadlocks = [...groups].map(([reason, deadlocks]) => ({ reason, deadlocks: deadlocks.sort() }))
    writeFileSync(path.join(here, 'coverage.json'), `${JSON.stringify({ ...coverage, knownDeadlocks }, null, 2)}\n`)
    console.log(`Recorded ${live.deadlocks.length} deadlock(s) in ${knownDeadlocks.length} group(s). Replace each UNREVIEWED reason with why it cannot happen, or fix the SQL.`)
    return true
  }
  let ok = true
  const known = new Map(coverage.knownDeadlocks.flatMap((group) => group.deadlocks.map((key) => [key, group.reason])))
  for (const deadlock of live.deadlocks) {
    if (known.has(deadlock.key) && !known.get(deadlock.key).startsWith('UNREVIEWED')) continue
    ok = false
    console.log(`FAIL ${known.has(deadlock.key) ? 'unreviewed' : 'new'} ${explain(deadlock)}`)
  }
  const liveKeys = new Set(live.deadlocks.map((deadlock) => deadlock.key))
  for (const key of known.keys()) {
    if (liveKeys.has(key)) continue
    ok = false
    console.log(`FAIL knownDeadlocks lists "${key}", which no longer deadlocks. Rerun with --record-known to drop it.`)
  }
  if (known.size) console.log(`known ${known.size} reviewed deadlock(s) in ${coverage.knownDeadlocks.length} group(s); see knownDeadlocks in coverage.json`)
  return ok
}

await prepareTlc()
if (adhoc.functions) process.exitCode = adhocRun() ? 1 : 0
else {
  const replays = replayRuns()
  const live = liveRun()
  const drift = driftProblems()
  for (const problem of drift) console.log(`FAIL drift ${problem}`)
  const ok = replays && live && !drift.length
  console.log(ok ? 'ok lock-order' : 'FAIL lock-order')
  process.exitCode = ok ? 0 : 1
}

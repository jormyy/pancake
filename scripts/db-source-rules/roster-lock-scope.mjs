import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { functionLifecycleEventsInSource, maskSqlNonCode, sourcePathForFunctionKey } from '../check-db-function-sources.mjs'

export const FIX = 'take roster locks through private.lock_roster_scope before any row lock'

const HELPER = 'private.lock_roster_scope'
const ROW_TABLES = ['roster_players', 'waiver_claims', 'trades', 'drafts']
const ROSTER_WRITE_TABLES = new Set(['roster_players', 'waiver_claims'])

const PENDING_TRADE_ENTRY_POINTS = new Set([
  'private.accept_trade_participant_atomic',
  'private.begin_trade_action',
  'private.guard_accepted_trade_capacity',
  'private.guard_trade_plan_reservations',
  'private.lock_trade_offer_assets',
  'public.complete_accepted_trade_atomic',
  'public.process_due_accepted_trades_atomic',
  'public.retract_trade_acceptance_atomic',
  'public.set_trade_roster_plan_atomic',
  'public.set_trade_taxi_destinations_atomic',
])

const tablePattern = ROW_TABLES.join('|')
const rowLockPattern = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b(?:\s+OF\s+[\w.]+(?:\s*,\s*[\w.]+)*)?(\s+(?:NOWAIT|SKIP\s+LOCKED))?/gi
const dmlPattern = new RegExp(`(?<!\\bFOR\\s+|\\bKEY\\s+|\\bDO\\s+|\\bON\\s+)\\b(UPDATE|DELETE\\s+FROM)\\s+(?:ONLY\\s+)?(?:public\\.)?(${tablePattern})\\b`, 'gi')
const fromPattern = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:ONLY\\s+)?(?:public\\.)?(${tablePattern})\\b`, 'i')
const writePattern = new RegExp(`\\b(?:UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+(?:ONLY\\s+)?(?:public\\.)?(${tablePattern})\\b`, 'gi')
const helperPattern = /\b(?:private\.)?lock_roster_scope\s*\(/gi
const advisoryPattern = /\bpg_advisory_xact_lock\s*\(/gi
const tryRosterPattern = /\bpg_try_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*[\w.]*league[\w.]*/i
const draftLockPattern = /\bpg_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*[\w.]*draft[\w.]*::text\s*\)\s*,\s*0\s*\)/i
const triggerPattern = /\bRETURNS\s+trigger\b/i

const closingParen = (code, open) => {
  let depth = 0
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '(') depth += 1
    else if (code[index] === ')' && --depth === 0) return index
  }
  return code.length
}

const topLevelArgs = (text) => {
  const args = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')') depth -= 1
    else if (text[index] === ',' && depth === 0) {
      args.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  args.push(text.slice(start).trim())
  return args
}

const statementStart = (code, index) => {
  let depth = 0
  for (let at = index - 1; at >= 0; at -= 1) {
    if (code[at] === ')') depth += 1
    else if (code[at] === '(') {
      if (depth === 0) return at + 1
      depth -= 1
    } else if (code[at] === ';' && depth === 0) return at + 1
  }
  return 0
}

const hashed = (arg) => arg.match(/^hashtext\s*\(\s*([\w.]+)/i)?.[1]?.toLowerCase()

const isRosterKey = (args) => {
  const [scope, key] = args.map(hashed)
  return args.length === 2 && Boolean(scope && key) && /league/.test(scope) && !/season/.test(scope) && !/season/.test(key)
}

const lineAt = (source, index) => source.slice(0, index).split('\n').length

const bodyOf = (definition) => {
  const quote = definition.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/i)
  if (!quote) return null
  const start = quote.index + quote[0].length
  const end = definition.indexOf(quote[1], start)
  return end === -1 ? null : { start, text: definition.slice(start, end) }
}

export const rosterLockScopeFailures = (source, file) => {
  const failures = []
  for (const event of functionLifecycleEventsInSource(source)) {
    if (event.type !== 'create' || event.key === HELPER) continue
    const body = bodyOf(event.definition)
    if (!body) continue
    const code = maskSqlNonCode(body.text, { dollarQuotes: false })
    const where = (index) => `${file}:${lineAt(source, event.start + body.start + index)} ${event.identityKey}`
    const pendingTrade = PENDING_TRADE_ENTRY_POINTS.has(event.key)

    const scopeCalls = []
    for (const hit of code.matchAll(helperPattern)) scopeCalls.push(hit.index)
    for (const hit of code.matchAll(advisoryPattern)) {
      const open = hit.index + hit[0].length - 1
      if (!isRosterKey(topLevelArgs(code.slice(open + 1, closingParen(code, open))))) continue
      scopeCalls.push(hit.index)
      if (!pendingTrade) failures.push(`${where(hit.index)} takes a raw team or player advisory lock; ${FIX}.`)
    }
    if (pendingTrade) continue

    const rowLocks = []
    for (const hit of code.matchAll(rowLockPattern)) {
      if (hit[1]) continue
      const statement = code.slice(statementStart(code, hit.index), hit.index)
      const table = statement.match(fromPattern)?.[1]?.toLowerCase()
      if (table) rowLocks.push({ at: hit.index, table, explicit: true })
    }
    for (const hit of code.matchAll(dmlPattern)) rowLocks.push({ at: hit.index, table: hit[2].toLowerCase() })
    rowLocks.sort((left, right) => left.at - right.at)

    const lastScope = Math.max(-1, ...scopeCalls)
    const early = rowLocks.find((lock) => lock.at < lastScope)
    if (early) {
      failures.push(`${where(early.at)} locks ${early.table} rows before its roster locks; ${FIX}.`)
      continue
    }
    if (scopeCalls.length || !event.key.startsWith('public.') || triggerPattern.test(event.definition.slice(0, body.start))) continue
    if (tryRosterPattern.test(code) || draftLockPattern.test(code)) continue
    const writes = [...code.matchAll(writePattern)].filter((hit) => ROSTER_WRITE_TABLES.has(hit[1].toLowerCase()))
    const unguarded = rowLocks.find((lock) => lock.explicit && ROSTER_WRITE_TABLES.has(lock.table))
    if (writes.length && unguarded) {
      failures.push(`${where(unguarded.at)} locks ${unguarded.table} rows to write them without team or player locks; ${FIX}.`)
    }
  }
  return failures
}

const canonicalSource = async (key, definition) => {
  const file = sourcePathForFunctionKey(key)
  const source = await readFile(file, 'utf8').catch(() => null)
  return source?.includes(definition) ? { file: path.relative(process.cwd(), file), source } : { file: key, source: definition }
}

export default async ({ definitions }) => {
  const failures = []
  for (const [key, definition] of definitions) {
    const { file, source } = await canonicalSource(key, definition)
    failures.push(...rosterLockScopeFailures(source, file))
  }
  return [...new Set(failures)]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('Usage: roster-lock-scope.mjs <sql file>...')
    process.exit(2)
  }
  const failures = []
  for (const file of files) failures.push(...rosterLockScopeFailures(await readFile(file, 'utf8'), path.relative(process.cwd(), file)))
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = failures.length ? 1 : 0
}

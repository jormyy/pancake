import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  functionDefinitionsInSource,
  latestFunctionDefinitions,
  maskSqlNonCode,
} from '../check-db-function-sources.mjs'

const TRADE_ENTRY_ORDER_MESSAGE =
  'Call private.begin_trade_action before writing or replaying (members, players, then trade; see 20261011000043)'

const GATE = 'private.begin_trade_action'
const TRADE_ID_PARAMETER = /\bp_(?:source_)?trade_id\s+uuid\b/i
const OFFER_RECEIPTS = /\bprivate\.trade_offer_requests\b/i
const USER_PARAMETER = /\bp_user_id\s+uuid\b/i
const MEMBER_PARAMETER = /\bp_\w*member_id\s+uuid\b/i
const TRADE_KEY_LOCK = /\bpg_(?:try_)?advisory_xact_lock\s*\(|\block_trade_offer_assets\s*\(/i
const GUARDED_STATEMENTS = [
  /(?<!\b(?:FOR|KEY|DO)\s+)\bUPDATE\s+(?!SKIP\b)[A-Za-z_"]/gi,
  /\bINSERT\s+INTO\b/gi,
  /\bDELETE\s+FROM\b/gi,
  /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b(?![^;]*\bSKIP\s+LOCKED\b)/gi,
  /\bpg_(?:try_)?advisory_xact_lock\s*\(/gi,
  /\block_trade_offer_assets\s*\(/gi,
  /\brequest_begin\s*\(/gi,
]
const EARLY_RETURN = /\bRETURN\b/gi

/** @param {string} definition */
const functionBody = (definition) => {
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(definition)
  if (!open) return null
  const start = open.index + open[0].length
  const end = definition.indexOf(open[1], start)
  return { start, text: maskSqlNonCode(definition.slice(start, end === -1 ? undefined : end), { dollarQuotes: false }) }
}

/** @param {string} key @param {string} definition */
const tradeEntryOrderFailures = (key, definition) => {
  if (key.startsWith(GATE)) return []
  const header = definition.slice(0, definition.search(/\bAS\s+\$/i))
  const body = functionBody(definition)
  if (!body) return []
  const actsForMember = USER_PARAMETER.test(header) || (key.startsWith('public.') && MEMBER_PARAMETER.test(header))
  const tradeAction = TRADE_ID_PARAMETER.test(header) && (actsForMember || TRADE_KEY_LOCK.test(body.text))
  if (!tradeAction && !OFFER_RECEIPTS.test(body.text)) return []

  const effects = GUARDED_STATEMENTS.flatMap((pattern) => [...body.text.matchAll(pattern)].map((match) => match.index))
  if (effects.length === 0) return []
  const guarded = [...effects, ...[...body.text.matchAll(EARLY_RETURN)].map((match) => match.index)]
    .sort((left, right) => left - right)[0]

  const gate = body.text.search(/\bprivate\.begin_trade_(?:action|offer)\s*\(/i)
  if (gate !== -1 && gate < guarded) return []

  const offset = body.start + guarded
  const line = definition.slice(0, offset).split('\n').length
  const statement = definition.slice(offset).split('\n')[0].trim()
  return [`${key} line ${line} (${statement}): ${TRADE_ENTRY_ORDER_MESSAGE}`]
}

/** @param {Map<string, string>} definitions */
export const tradeEntryOrderFailuresIn = (definitions) =>
  [...definitions].flatMap(([key, definition]) => tradeEntryOrderFailures(key, definition))

const runCli = async () => {
  const files = process.argv.slice(2)
  const definitions = files.length === 0
    ? await latestFunctionDefinitions()
    : new Map((await Promise.all(files.map(async (file) =>
      [...functionDefinitionsInSource(await readFile(file, 'utf8'))]))).flat())
  const failures = tradeEntryOrderFailuresIn(definitions)
  for (const failure of failures) console.error(`- ${failure}`)
  if (failures.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

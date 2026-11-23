import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  functionDefinitionsInSource,
  latestFunctionDefinitions,
  latestFunctionDefinitionsInSource,
  maskSqlNonCode,
} from '../check-db-function-sources.mjs'

const TWO_PARTY_MESSAGE =
  'Read trade_participants / trade_items.from_member_id; two-team columns are display-only.'

const DISPLAY_LINES = new Map([
  ['private.prevent_trade_status_client_writes', [
    'OR NEW.recipient_member_id IS DISTINCT FROM OLD.recipient_member_id',
  ]],
  ['public.public_read_v2', [
    't.recipient_member_id,',
  ]],
  ['public.expire_pending_trades_atomic', [
    'RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id',
    'expired.recipient_member_id,',
  ]],
  ['private.expire_pending_trades_for_lost_asset', [
    'RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id',
    'expired.recipient_member_id,',
  ]],
  ['public.process_due_accepted_trades_atomic', [
    'trade.recipient_member_id,',
    'v_trade.recipient_member_id,',
  ]],
  ['public.expire_trade_completion_failure_atomic', [
    'v_trade.recipient_member_id,',
  ]],
  ['public.complete_accepted_trade_atomic', [
    'v_trade.recipient_member_id,',
  ]],
  ['private.replace_multi_team_trade_offer', [
    'v_new_trade.recipient_member_id,',
  ]],
])

const COLUMN_READS = /\brecipient_member_id\b|\btrade_side\b/gi
const SIDE_COMPARISONS =
  /\bside\s*(?:=|<>|!=|\bIN\s*\()\s*'(?:proposer|recipient)'|'(?:proposer|recipient)'(?:\s*::\s*(?:public\.)?trade_side)?\s*(?:=|<>|!=)\s*(?:\w+\.)?side\b/gi
const SIDE_LITERAL_CAST = /'[^']*'\s*::\s*(?:public\.)?$/i
const DISPLAY_KEY = /'recipient[A-Za-z]*'\s*,/
const TRADES_INSERT = /\bINSERT\s+INTO\s+(?:public\.)?trades\s*\(/gi

/** @param {string} text @param {number} open */
const closingParen = (text, open) => {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')' && --depth === 0) return index
  }
  return text.length
}

/** @param {string} text */
const maskComments = (text) => {
  const chars = text.split('')
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "'") quoted = !quoted
    else if (!quoted && text.startsWith('--', index)) {
      while (index < text.length && text[index] !== '\n') chars[index++] = ' '
    }
  }
  return chars.join('')
}

/** @param {string} definition */
const functionBody = (definition) => {
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(definition)
  if (!open) return null
  const start = open.index + open[0].length
  const end = definition.indexOf(open[1], start)
  return { start, end: end === -1 ? definition.length : end }
}

/** @param {string} key @param {string} definition */
const twoPartyFailures = (key, definition) => {
  const range = functionBody(definition)
  if (!range) return []
  const body = definition.slice(range.start, range.end)
  const withStrings = maskComments(body)
  const code = maskSqlNonCode(body, { dollarQuotes: false })
  const columnLists = [...code.matchAll(TRADES_INSERT)].map((match) => {
    const open = match.index + match[0].length - 1
    return [open, closingParen(code, open)]
  })
  const lineStart = (offset) => withStrings.lastIndexOf('\n', offset - 1) + 1

  const columnHits = [...code.matchAll(COLUMN_READS)].map((match) => match.index).filter((offset) => {
    const before = withStrings.slice(lineStart(offset), offset)
    if (SIDE_LITERAL_CAST.test(before)) return false
    if (DISPLAY_KEY.test(before)) return false
    return !columnLists.some(([open, close]) => offset > open && offset < close)
  })
  const sideHits = [...withStrings.matchAll(SIDE_COMPARISONS)].map((match) => match.index)

  const displayLines = new Set(DISPLAY_LINES.get(key) ?? [])
  const lines = new Map()
  for (const offset of [...columnHits, ...sideHits].sort((left, right) => left - right)) {
    const absolute = range.start + offset
    const line = definition.slice(0, absolute).split('\n').length
    const statement = definition.split('\n')[line - 1].trim()
    if (!displayLines.has(statement)) lines.set(line, statement)
  }
  return [...lines].map(([line, statement]) => `${key} line ${line} (${statement}): ${TWO_PARTY_MESSAGE}`)
}

/** @param {Map<string, string>} definitions */
export const twoPartyFailuresIn = (definitions) =>
  [...definitions].flatMap(([key, definition]) => twoPartyFailures(key, definition))

export default ({ definitions }) => twoPartyFailuresIn(definitions)

/** @param {string} directory */
const latestDefinitionsIn = async (directory) => {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
  const sources = await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')))
  return latestFunctionDefinitionsInSource(sources.join('\n'))
}

const runCli = async () => {
  const [flag, directory] = process.argv.slice(2)
  const files = process.argv.slice(2)
  const definitions = flag === '--migrations'
    ? await latestDefinitionsIn(directory)
    : files.length === 0
      ? await latestFunctionDefinitions()
      : new Map((await Promise.all(files.map(async (file) =>
        [...functionDefinitionsInSource(await readFile(file, 'utf8'))]))).flat())
  const failures = twoPartyFailuresIn(definitions)
  for (const failure of failures) console.error(`- ${failure}`)
  if (failures.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

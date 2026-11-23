import { pathToFileURL } from 'node:url'
import { maskSqlNonCode } from '../check-db-function-sources.mjs'

const EXACT_TIME_GATE_FIX = 'exact-time cron gate; add a private.work_kinds row with a cadence'

const GATED_FIELDS = new Set(['minute', 'hour', 'isodow', 'dow'])
const GATE_AFTER = /^(?:=(?!>)|<>|!=|%)/
const GATE_BEFORE = /(?:(?<![<>!:])=|<>|!=|%)$/
const TRAILING_CASTS = /^(?:\s*::\s*[A-Za-z_]\w*|\s*\))*\s*/
const ASSIGNED_TO = /([A-Za-z_]\w*)(?:\s+[A-Za-z_]\w*)?\s*:=\s*\(*\s*$/

const closingParen = (masked, open) => {
  let depth = 0
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === '(') depth += 1
    else if (masked[index] === ')' && --depth === 0) return index
  }
  return -1
}

const gateAt = (source, index) => {
  const line = source.slice(0, index).split('\n').length
  return { line, text: source.split('\n')[line - 1].trim() }
}

const timeField = (raw, masked, name, open, close) => {
  const inner = name === 'extract' ? masked.slice(open + 1, close) : raw.slice(open + 1, close)
  const match = name === 'extract' ? /^\s*([A-Za-z]+)\s+FROM\b/i.exec(inner) : /^\s*'([A-Za-z]+)'/.exec(inner)
  return match?.[1].toLowerCase()
}

const exactTimeGates = (definition) => {
  const masked = maskSqlNonCode(definition, { dollarQuotes: false })
  const gates = []
  const variables = new Set()
  const call = /\b(extract|date_part)\s*\(/gi
  let match
  while ((match = call.exec(masked)) !== null) {
    const name = match[1].toLowerCase()
    const open = match.index + match[0].length - 1
    const close = closingParen(masked, open)
    if (close === -1 || !GATED_FIELDS.has(timeField(definition, masked, name, open, close) ?? '')) continue
    const after = masked.slice(close + 1).replace(TRAILING_CASTS, '')
    const before = masked.slice(0, match.index).replace(/[\s(]*$/, '')
    if (GATE_AFTER.test(after) || GATE_BEFORE.test(before)) {
      gates.push(gateAt(definition, match.index))
      continue
    }
    const assigned = ASSIGNED_TO.exec(masked.slice(0, match.index))
    if (assigned) variables.add(assigned[1])
  }
  for (const variable of variables) {
    const use = new RegExp(`\\b${variable}\\b\\s*(?:=(?!>)|<>|!=|%)|(?:(?<![<>!:])=|<>|!=)\\s*\\b${variable}\\b`, 'g')
    while ((match = use.exec(masked)) !== null) {
      gates.push(gateAt(definition, match.index))
    }
  }
  return [...new Map(gates.map((gate) => [gate.line, gate])).values()].sort((left, right) => left.line - right.line)
}

export default function noExactTimeGates(definitions) {
  return [...definitions].flatMap(([key, definition]) =>
    exactTimeGates(definition).map((gate) => `${key} line ${gate.line} '${gate.text}': ${EXACT_TIME_GATE_FIX}`))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { latestFunctionDefinitions } = await import('../check-db-function-sources.mjs')
  const failures = noExactTimeGates(await latestFunctionDefinitions())
  for (const failure of failures) console.error(`- ${failure}`)
  if (failures.length > 0) process.exitCode = 1
}

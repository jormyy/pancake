import { pathToFileURL } from 'node:url'

const MESSAGE = 'nba_games.status only holds Scheduled, InProgress or Final; postponed, cancelled and suspended games are marked in game_status_text. Use private.lineup_game_available(status, game_status_text).'

const CLASSIFIER = 'private.lineup_game_available'
const UNAVAILABLE_LITERAL = /'(Postponed|Cancelled|Canceled|Suspended|PPD)'/
const STATUS_COMPARISON = /\bstatus\b[^\n;]{0,16}?(?:\bNOT\s+IN\s*\(|\bIN\s*\(|<>|!=|=)\s*([^)\n;]*)/gi
const TEXT_PATTERN = /\bstatus_text\b[^\n;]{0,24}?(?:!?~\*?|\bI?LIKE\b|\bSIMILAR\s+TO\b)/gi

const stripComments = (source) => source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))

const lineAt = (source, index) => source.slice(0, index).split('\n').length

const deadAvailabilityChecks = (key, definition) => {
  const code = stripComments(definition)
  const findings = []
  for (const match of code.matchAll(STATUS_COMPARISON)) {
    if (UNAVAILABLE_LITERAL.test(match[1])) findings.push({ line: lineAt(code, match.index), text: match[0].trim() })
  }
  if (key !== CLASSIFIER) {
    for (const match of code.matchAll(TEXT_PATTERN)) findings.push({ line: lineAt(code, match.index), text: match[0].trim() })
  }
  return findings
}

export default function noDeadPostponedStatus({ definitions }) {
  return [...definitions].flatMap(([key, definition]) =>
    deadAvailabilityChecks(key, definition).map((finding) => `${key} line ${finding.line} '${finding.text}': ${MESSAGE}`))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { latestFunctionDefinitions } = await import('../check-db-function-sources.mjs')
  const failures = noDeadPostponedStatus({ definitions: await latestFunctionDefinitions() })
  for (const failure of failures) console.error(`- ${failure}`)
  if (failures.length > 0) process.exitCode = 1
}

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const MESSAGE = 'nba_games.status only holds Scheduled, InProgress or Final; postponed, cancelled and suspended games are marked in game_status_text. Use private.lineup_game_available(status, game_status_text).'

const CLASSIFIER = 'private/lineup_game_available.sql'
const UNAVAILABLE_LITERAL = /'(Postponed|Cancelled|Canceled|Suspended|PPD)'/
const STATUS_COMPARISON = /\bstatus\b[^\n;]{0,16}?(?:\bNOT\s+IN\s*\(|\bIN\s*\(|<>|!=|=)\s*([^)\n;]*)/gi
const TEXT_PATTERN = /\bstatus_text\b[^\n;]{0,24}?(?:!?~\*?|\bI?LIKE\b|\bSIMILAR\s+TO\b)/gi

const stripComments = (source) => source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))

const lineAt = (source, index) => source.slice(0, index).split('\n').length

async function sqlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sqlFiles(full)
    return entry.name.endsWith('.sql') ? [full] : []
  }))
  return nested.flat().sort()
}

export function findDeadAvailabilityChecks(rel, source) {
  const code = stripComments(source)
  const findings = []
  for (const match of code.matchAll(STATUS_COMPARISON)) {
    if (UNAVAILABLE_LITERAL.test(match[1])) findings.push({ file: rel, line: lineAt(code, match.index), text: match[0].trim() })
  }
  if (!rel.endsWith(CLASSIFIER)) {
    for (const match of code.matchAll(TEXT_PATTERN)) findings.push({ file: rel, line: lineAt(code, match.index), text: match[0].trim() })
  }
  return findings
}

export async function checkDeadAvailabilityChecks(root) {
  const base = path.join(root, 'supabase/sql/functions/by-name')
  const files = await sqlFiles(base)
  const results = await Promise.all(files.map(async (file) => findDeadAvailabilityChecks(path.relative(root, file), await readFile(file, 'utf8'))))
  return results.flat()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? process.cwd())
  const findings = await checkDeadAvailabilityChecks(root)
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.text}\n  ${MESSAGE}`)
  if (findings.length) process.exitCode = 1
}

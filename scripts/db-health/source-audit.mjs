import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { maskSqlNonCode } from '../check-db-function-sources.mjs'

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name)
    return entry.isDirectory() ? files(file) : [file]
  })
}

function sqlCode(source) {
  const body = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(source)
  if (!body) return maskSqlNonCode(source)
  const delimiter = body[1]
  const start = body.index + body[0].lastIndexOf(delimiter)
  const contentStart = start + delimiter.length
  const end = source.indexOf(delimiter, contentStart)
  if (end < 0) throw new Error('Unterminated function body')
  return maskSqlNonCode(source.slice(0, start)) + ' '.repeat(delimiter.length)
    + maskSqlNonCode(source.slice(contentStart, end)) + ' '.repeat(delimiter.length)
    + maskSqlNonCode(source.slice(end + delimiter.length))
}

export function sourceAudit(root = 'supabase/sql/functions/by-name') {
  const functions = files(root).filter(file => file.endsWith('.sql')).map(file => {
    const source = readFileSync(file, 'utf8')
    const code = sqlCode(source)
    const writes = [...code.matchAll(/\b(?:UPDATE\s+(?!SET\b)|INSERT\s+INTO\s+|DELETE\s+FROM\s+)/gi)]
      .filter(match => !/\bFOR(?:\s+NO\s+KEY)?\s*$/i.test(code.slice(Math.max(0, match.index - 40), match.index)))
    const stars = [...code.matchAll(/\bSELECT\s+(?:\w+\.)?\*/gi)]
    const locations = expression => [...code.matchAll(expression)].map(match => source.slice(0, match.index).split('\n').length)
    return {
      file,
      writeSites: writes.map(match => ({ line: source.slice(0, match.index).split('\n').length, operation: match[0].trim() })),
      conflictUpdateLines: locations(/\bDO\s+UPDATE\s+SET\b/gi),
      rowLockLines: locations(/\bFOR\s+(?:(?:NO\s+KEY\s+)?UPDATE|(?:KEY\s+)?SHARE)\b/gi),
      dynamicSqlLines: locations(/\bEXECUTE\b/gi),
      selectStarLines: stars.map(match => source.slice(0, match.index).split('\n').length),
      hasDistinctGate: /\bIS\s+DISTINCT\s+FROM\b/i.test(code),
      hasConflictClause: /\bON\s+CONFLICT\b/i.test(code),
      hasStatementTimeout: /\bSET\s+statement_timeout\b/i.test(code),
      hasLockTimeout: /\bSET\s+lock_timeout\b/i.test(code),
      hasLimit: /\bLIMIT\b/i.test(code),
    }
  })

  return {
    evidence: 'Review candidates from SQL code. Literals, comments, and row-lock clauses are excluded from direct writes. Dynamic SQL requires separate review. A gate anywhere in a function does not prove every write uses it.',
    summary: {
      functions: functions.length,
      functionsWithWrites: functions.filter(item => item.writeSites.length).length,
      writeSites: functions.reduce((sum, item) => sum + item.writeSites.length, 0),
      conflictUpdateSites: functions.reduce((sum, item) => sum + item.conflictUpdateLines.length, 0),
      rowLockSites: functions.reduce((sum, item) => sum + item.rowLockLines.length, 0),
      functionsWithDynamicSql: functions.filter(item => item.dynamicSqlLines.length).length,
      selectStarSites: functions.reduce((sum, item) => sum + item.selectStarLines.length, 0),
      writeFunctionsWithoutDistinctGate: functions.filter(item => item.writeSites.length && !item.hasDistinctGate).length,
      writeFunctionsWithoutLockTimeout: functions.filter(item => item.writeSites.length && !item.hasLockTimeout).length,
      writeFunctionsWithoutStatementTimeout: functions.filter(item => item.writeSites.length && !item.hasStatementTimeout).length,
    },
    functions,
  }
}

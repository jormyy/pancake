import { pathToFileURL } from 'node:url'
import { maskSqlNonCode } from '../check-db-function-sources.mjs'

const READ_LOCK_FIX = 'read RPCs must not lock; move the lock to the writer RPC'
const UNBOUNDED_FIX = 'unbounded worker statement; batch with LIMIT and return remaining'
const MAX_WORKER_BATCH = 5000

const ROW_LOCK = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b|\bLOCK\s+TABLE\b/gi
const WORKER_WRITE = /\bDELETE\s+FROM\b|\bUPDATE\s+(?:ONLY\s+)?[A-Za-z_"][\w."]*(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+SET\b/i
const CALL = /(?:\b([A-Za-z_]\w*)\s*\.\s*)?\b([A-Za-z_]\w*)\s*\(/g

const splitFunction = (definition) => {
  const masked = maskSqlNonCode(definition, { dollarQuotes: false })
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(masked)
  if (!open) return { header: masked, body: '', bodyStart: masked.length }
  const bodyStart = open.index + open[0].length
  const close = masked.indexOf(open[1], bodyStart)
  const bodyEnd = close === -1 ? masked.length : close
  return {
    header: masked.slice(0, open.index) + masked.slice(bodyEnd + open[1].length),
    body: masked.slice(bodyStart, bodyEnd),
    bodyStart,
  }
}

const lineOf = (definition, index) => {
  const line = definition.slice(0, index).split('\n').length
  return { line, text: definition.split('\n')[line - 1].trim() }
}

const nameOf = (key) => key.replace(/\(.*$/, '')

const parse = (definitions) => {
  const functions = new Map()
  const byName = new Map()
  for (const [key, definition] of definitions) {
    const { header, body, bodyStart } = splitFunction(definition)
    const lock = new RegExp(ROW_LOCK.source, 'gi').exec(body)
    functions.set(key, {
      key,
      definition,
      body,
      bodyStart,
      readOnly: /\b(?:STABLE|IMMUTABLE)\b/i.test(header),
      lock: lock ? lineOf(definition, bodyStart + lock.index) : null,
    })
    const name = nameOf(key)
    byName.set(name, [...byName.get(name) ?? [], key])
  }
  for (const fn of functions.values()) {
    const callees = new Set()
    for (const match of fn.body.matchAll(CALL)) {
      const schema = match[1]?.toLowerCase() ?? 'public'
      for (const callee of byName.get(`${schema}.${match[2].toLowerCase()}`) ?? []) {
        if (callee !== fn.key) callees.add(callee)
      }
    }
    fn.callees = [...callees]
  }
  return functions
}

const lockPath = (functions, root) => {
  const seen = new Set([root])
  const queue = [[root]]
  while (queue.length > 0) {
    const chain = queue.shift()
    const fn = functions.get(chain.at(-1))
    if (fn.lock) return { chain, lock: fn.lock }
    for (const callee of fn.callees) {
      if (seen.has(callee)) continue
      seen.add(callee)
      queue.push([...chain, callee])
    }
  }
  return null
}

const readLockFailures = (functions) => [...functions.values()]
  .filter((fn) => fn.readOnly)
  .flatMap((fn) => {
    const found = lockPath(functions, fn.key)
    if (!found) return []
    return [`${found.chain.join(' -> ')} line ${found.lock.line} '${found.lock.text}': ${READ_LOCK_FIX}`]
  })

const isWorker = (key) => /^private\.(?:retain|prune)_/.test(key)

const topLevelStatements = (body) => {
  const statements = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '(') depth += 1
    else if (body[index] === ')') depth -= 1
    else if (body[index] === ';' && depth === 0) {
      statements.push({ text: body.slice(start, index), start })
      start = index + 1
    }
  }
  statements.push({ text: body.slice(start), start })
  return statements
}

const unboundedWorkerFailures = (functions) => [...functions.values()]
  .filter((fn) => isWorker(fn.key))
  .flatMap((fn) => topLevelStatements(fn.body).flatMap((statement) => {
    const write = WORKER_WRITE.exec(statement.text)
    if (!write) return []
    const at = lineOf(fn.definition, fn.bodyStart + statement.start + write.index)
    const limits = [...statement.text.matchAll(/\bLIMIT\s+(\d+)\b|\bLIMIT\s+[A-Za-z_$]/gi)]
    if (limits.length === 0) return [`${fn.key} line ${at.line} '${at.text}': ${UNBOUNDED_FIX}`]
    const oversized = limits.map((limit) => Number(limit[1] ?? 0)).filter((rows) => rows > MAX_WORKER_BATCH)
    return oversized.map((rows) =>
      `${fn.key} line ${at.line} LIMIT ${rows} is above ${MAX_WORKER_BATCH} rows: ${UNBOUNDED_FIX}`)
  }))

export default function boundedWorkers({ definitions }) {
  const functions = parse(definitions)
  return [...readLockFailures(functions), ...unboundedWorkerFailures(functions)]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { latestFunctionDefinitions } = await import('../check-db-function-sources.mjs')
  const failures = boundedWorkers({ definitions: await latestFunctionDefinitions() })
  for (const failure of failures) console.error(`- ${failure}`)
  if (failures.length > 0) process.exitCode = 1
}

#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const roleAliases = {
  bidder: 'member',
  current_bidder: 'member',
  team: 'member',
  owner: 'member',
  from_member: 'member',
  to_member: 'member',
  proposer_member: 'member',
  recipient_member: 'member',
  league_member: 'member',
  rookie_draft: 'draft',
  target_player: 'player',
}
const keyRoles = new Set(['league', 'member', 'player', 'draft'])
const castWords = new Set(['hashtext', 'hashtextextended', 'pg_catalog', 'text', 'bigint', 'int', 'integer', 'int4', 'int8', 'uuid', 'varchar'])
const sqlWords = new Set([
  'as', 'on', 'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'lateral', 'using', 'group', 'order', 'limit', 'offset', 'for', 'having', 'window', 'union', 'into', 'and', 'or', 'set', 'returning', 'only', 'select', 'values', 'default',
])

const mask = (sql) => {
  let out = ''
  for (let i = 0; i < sql.length; ) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      out += ' '.repeat(stop - i)
      i = stop
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1
      out += sql.slice(i, j + 1)
      i = j + 1
    } else {
      out += sql[i]
      i += 1
    }
  }
  return out
}

const blankStrings = (text) => text.replace(/'(?:[^']|'')*'/g, (literal) => `'${'_'.repeat(Math.max(0, literal.length - 2))}'`)

const closingParen = (text, open) => {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) return text.length
      i = end
    } else if (text[i] === '(') depth += 1
    else if (text[i] === ')' && --depth === 0) return i
  }
  return text.length
}

const splitTopLevel = (text) => {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) break
      i = end
    } else if (text[i] === '(') depth += 1
    else if (text[i] === ')') depth -= 1
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

const flatten = (text) => {
  let out = ''
  let depth = 0
  for (const char of text) {
    if (char === '(') {
      if (depth === 0) out += '('
      depth += 1
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
      if (depth === 0) out += ')'
    } else if (depth === 0) out += char
  }
  return out
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

const normalizeRole = (reference) => {
  const segments = reference.toLowerCase().split('.')
  let name = segments.at(-1) === 'id' && segments.length > 1 ? segments.at(-2) : segments.at(-1)
  name = name.replace(/^(p|v|new|old)_/, '').replace(/^lock_(?=\w)/, '').replace(/_lock$/, '').replace(/_ids?$/, '')
  return roleAliases[name] ?? name
}

const loopBindings = (code) =>
  [...code.matchAll(/\bFOR(?:EACH)?\s+(\w+)\s+IN\s+(?:ARRAY\s+)?([\s\S]*?)\bLOOP\b/gi)].flatMap((hit) => {
    const source = [...hit[2].matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)].map((token) => normalizeRole(token[0])).find((name) => keyRoles.has(name))
    return source ? [{ at: hit.index, variable: hit[1].toLowerCase(), source }] : []
  })

const boundAt = (bindings, at) => {
  const map = new Map()
  for (const binding of bindings) if (binding.at < at) map.set(binding.variable, binding.source)
  return map
}

const rowKey = (statement) => statement.match(/\bWHERE\s+(?:\w+\.)?id\s*=\s*([\w.]+)(?:::\w+)?\s*(?:$|\bAND\b|\bFOR\b|;|\bRETURNING\b)/i)?.[1]?.toLowerCase()

const keyClass = (args, bindings) =>
  args
    .map((arg) => {
      const tokens = [...arg.matchAll(/'((?:[^']|'')*)'|\b\d+\b|[A-Za-z_]\w*(?:\[\d+\])?(?:\.[A-Za-z_]\w*)*/g)]
        .map((hit) => {
          if (hit[1] !== undefined) return hit[1].replace(/:$/, '')
          if (/^\d+$/.test(hit[0])) return hit[0]
          const named = normalizeRole(hit[0])
          return keyRoles.has(named) ? named : (bindings.get(hit[0].toLowerCase()) ?? named)
        })
        .filter((token) => !castWords.has(token))
      return tokens.join('+') || arg
    })
    .join(':')

const statementStart = (code, index) => {
  let depth = 0
  for (let i = index - 1; i >= 0; i -= 1) {
    if (code[i] === ')') depth += 1
    else if (code[i] === '(') {
      if (depth === 0) return i + 1
      depth -= 1
    } else if (code[i] === ';' && depth === 0) return i + 1
  }
  return 0
}

const statementEnd = (code, index) => {
  let depth = 0
  for (let i = index; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1
    else if (code[i] === ')') {
      if (depth === 0) return i
      depth -= 1
    } else if (code[i] === ';' && depth === 0) return i
  }
  return code.length
}

const fromTables = (statement) => {
  const whole = flatten(statement)
  const selects = [...whole.matchAll(/\b(?:SELECT|PERFORM)\b/gi)]
  const flat = selects.length ? whole.slice(selects.at(-1).index) : whole
  const fromAt = flat.search(/\bFROM\b/i)
  if (fromAt === -1) return []
  const clause = flat.slice(fromAt).split(/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|OFFSET|HAVING|WINDOW|UNION|FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE)\b/i)[0]
  const tables = []
  for (const piece of clause.replace(/^FROM\b/i, '').split(/,|\b(?:(?:NATURAL\s+)?(?:LEFT|RIGHT|FULL|INNER|CROSS)?\s*(?:OUTER\s+)?JOIN)\b/i)) {
    const hit = piece.trim().match(/^(?:ONLY\s+)?((?:\w+\.)?\w+)(\s*\()?(?:\s+(?:AS\s+)?(\w+))?/i)
    if (!hit || hit[2] || sqlWords.has(hit[1].toLowerCase())) continue
    const table = tableName(hit[1])
    const alias = hit[3] && !sqlWords.has(hit[3].toLowerCase()) ? hit[3].toLowerCase() : table.split('.').at(-1)
    tables.push({ table, alias })
  }
  return tables
}

const statusStates = (statement, alias) => {
  const where = statement.match(/\bWHERE\b([\s\S]*)$/i)?.[1] ?? ''
  if (/\bOR\b/i.test(blankStrings(where))) return undefined
  const column = `(?:${alias}\\.)?status`
  const equal = where.match(new RegExp(`(?<![\\w.])${column}\\s*=\\s*'(\\w+)'`, 'i'))
  if (equal) return [equal[1]]
  const list = where.match(new RegExp(`(?<![\\w.])${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i'))
  if (list && /^\s*'\w+'(?:\s*,\s*'\w+')*\s*$/.test(list[1])) return [...list[1].matchAll(/'(\w+)'/g)].map((hit) => hit[1]).sort()
  return undefined
}

const tableName = (name) => name.toLowerCase().replace(/^public\./, '')

const rowModes = { 'NO KEY UPDATE': 'nokey', UPDATE: 'update', 'KEY SHARE': 'keyshare', SHARE: 'share' }

const eventPattern =
  /\bpg_(try_)?advisory_xact_lock(_shared)?\s*\(|\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b((?:\s+OF\s+[\w.]+(?:\s*,\s*[\w.]+)*)?)(\s+(?:NOWAIT|SKIP\s+LOCKED))?|(?<!\bFOR\s+|\bKEY\s+|\bDO\s+|\bOR\s+|\bBEFORE\s+|\bAFTER\s+|\bON\s+)\bUPDATE\s+(?:ONLY\s+)?((?:\w+\.)?\w+)|\bDELETE\s+FROM\s+(?:ONLY\s+)?((?:\w+\.)?\w+)|\bINSERT\s+INTO\s+((?:\w+\.)?\w+)/gi

const ownEvents = (body) => {
  const code = blankStrings(body)
  const bindings = loopBindings(code)
  const events = []
  for (const hit of code.matchAll(eventPattern)) {
    const line = lineAt(body, hit.index)
    if (hit[0].toLowerCase().startsWith('pg_')) {
      const open = hit.index + hit[0].length - 1
      const args = splitTopLevel(body.slice(open + 1, closingParen(body, open)))
      events.push({ at: hit.index, line, lock: { kind: 'advisory', resource: `advisory ${keyClass(args, boundAt(bindings, hit.index))}`, mode: hit[2] ? 'share' : 'update', wait: !hit[1] } })
    } else if (hit[3]) {
      const mode = rowModes[hit[3].toUpperCase().replace(/\s+/g, ' ')]
      const statement = body.slice(statementStart(code, hit.index), hit.index)
      const only = hit[4] ? hit[4].replace(/^\s*OF\s+/i, '').split(',').map((name) => name.trim().toLowerCase()) : null
      const tables = fromTables(blankStrings(statement)).filter(({ table, alias }) => !only || only.includes(alias) || only.includes(table))
      const into = tables.length === 1 ? statement.match(/\bINTO\s+(?:STRICT\s+)?(\w+)\s+FROM\b/i)?.[1] : undefined
      for (const { table, alias } of tables) {
        const states = statusStates(statement, alias) ?? (into ? checkedStates(body, statementEnd(code, hit.index), into) : undefined)
        events.push({ at: hit.index, line, lock: { kind: 'select', resource: `row ${table}`, states, row: rowKey(statement), mode, wait: !hit[5] } })
      }
    } else {
      const raw = hit[6] ?? hit[7] ?? hit[8]
      if (sqlWords.has(raw.toLowerCase())) continue
      const table = tableName(raw)
      const op = hit[6] ? 'update' : hit[7] ? 'delete' : 'insert'
      const statement = body.slice(hit.index, statementEnd(code, hit.index))
      const alias = statement.match(/^\w+\s+(?:INTO\s+|FROM\s+)?(?:ONLY\s+)?(?:\w+\.)?\w+\s+(?:AS\s+)?(\w+)/i)?.[1]
      const states = statusStates(statement, alias && !sqlWords.has(alias.toLowerCase()) ? alias : table.split('.').at(-1))
      events.push({
        at: hit.index,
        line,
        dml: { table, op },
        lock: op === 'insert' ? null : { kind: 'dml', resource: `row ${table}`, states, row: rowKey(statement), mode: op === 'update' ? 'nokey' : 'update', wait: true },
      })
    }
  }
  for (const hit of code.matchAll(raisePattern)) events.push({ at: hit.index, line: lineAt(body, hit.index), end: 'abort' })
  for (const hit of code.matchAll(returnPattern)) events.push({ at: hit.index, line: lineAt(body, hit.index), end: 'return' })
  return events
}

const raisePattern = /\bRAISE(?:\s+EXCEPTION\b|\s+SQLSTATE\b|\s+USING\b|\s*'|\s*;)/gi
const returnPattern = /\bRETURN\b(?!\s+(?:NEXT|QUERY)\b)/gi

const checkedStates = (code, from, variable) => {
  const next = code.slice(from).match(new RegExp(`\\bIF\\b((?:(?!\\bTHEN\\b)[\\s\\S])*?\\b${variable}\\.status\\b(?:(?!\\bTHEN\\b)[\\s\\S])*?)\\bTHEN\\s+RAISE\\b`, 'i'))
  if (!next || /\bAND\b/i.test(flatten(next[1]))) return undefined
  const condition = next[1]
  const unequal = condition.match(new RegExp(`\\b${variable}\\.status\\s*(?:<>|!=|IS\\s+DISTINCT\\s+FROM)\\s*'(\\w+)'`, 'i'))
  if (unequal) return [unequal[1]]
  const outside = condition.match(new RegExp(`\\b${variable}\\.status\\s+NOT\\s+IN\\s*\\(([^)]*)\\)`, 'i'))
  if (outside && /^\s*'\w+'(?:\s*,\s*'\w+')*\s*$/.test(outside[1])) return [...outside[1].matchAll(/'(\w+)'/g)].map((hit) => hit[1]).sort()
  return undefined
}

const controlPattern = /\bEND\s+IF\b|\bEND\s+LOOP\b|\bEND\s+CASE\b|\bEND\b|\bELSIF\b|\bELSEIF\b|\bELSE\b|\bTHEN\b|\bIF\b|\bCASE\b|\bBEGIN\b|\bLOOP\b/gi

const controlTokens = (code) => {
  const tokens = []
  for (const hit of code.matchAll(controlPattern)) {
    const word = hit[0].toUpperCase().replace(/\s+/g, ' ')
    if (word === 'IF' && !/(?:^|;|\bTHEN|\bELSE|\bLOOP|\bBEGIN|>>|\bEXCEPTION)$/i.test(code.slice(0, hit.index).trimEnd())) continue
    tokens.push({ at: hit.index, word })
  }
  return tokens
}

const buildTree = (code, items) => {
  const root = []
  const stack = [{ kind: 'block', steps: root }]
  const target = () => {
    const frame = stack.at(-1)
    if (frame.kind !== 'if') return frame.steps
    return frame.branches.length ? frame.branches.at(-1) : frame.parent
  }
  const merged = [...controlTokens(code).map((token) => ({ ...token, control: true })), ...items].sort((a, b) => a.at - b.at)
  for (const item of merged) {
    if (!item.control) {
      target().push(...item.steps)
      continue
    }
    const frame = stack.at(-1)
    if (item.word === 'IF') stack.push({ kind: 'if', parent: target(), branches: [], open: false, hasElse: false, from: item.at + 2 })
    else if (item.word === 'THEN' && frame.kind === 'if' && !frame.open) {
      if (!frame.branches.length) frame.condition = code.slice(frame.from, item.at).replace(/\s+/g, ' ').trim()
      if (!frame.branches.length) frame.branches.push([])
      frame.open = true
    } else if ((item.word === 'ELSIF' || item.word === 'ELSEIF') && frame.kind === 'if') {
      frame.branches.push([])
      frame.open = false
      frame.chained = true
    } else if (item.word === 'ELSE' && frame.kind === 'if') {
      frame.branches.push([])
      frame.open = true
      frame.hasElse = true
    } else if (item.word === 'END IF' && frame.kind === 'if') {
      stack.pop()
      frame.parent.push({ branches: frame.hasElse ? frame.branches : [...frame.branches, []], ...(frame.chained ? {} : { condition: frame.condition }) })
    } else if (item.word === 'CASE' || item.word === 'BEGIN' || item.word === 'LOOP') stack.push({ kind: item.word, steps: target() })
    else if ((item.word === 'END' || item.word === 'END LOOP' || item.word === 'END CASE') && frame.kind !== 'if' && stack.length > 1) stack.pop()
  }
  return root
}

const definitionPattern = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/gi
const triggerPattern =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]*?)\s+ON\s+((?:\w+\.)?\w+)[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+((?:\w+\.)?\w+)\s*\(/gi
const dropTriggerPattern = /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+((?:\w+\.)?\w+)/gi
const dropFunctionPattern = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?((?:"?\w+"?\.)?"?\w+"?)\s*\(/gi

const parameterRange = (signature) => {
  const params = splitTopLevel(signature).filter((param) => !/^\s*OUT\b/i.test(param))
  const variadic = params.some((param) => /^\s*VARIADIC\b/i.test(param))
  const required = params.filter((param) => !/\bDEFAULT\b|=/i.test(param) && !/^\s*VARIADIC\b/i.test(param)).length
  return { min: required, max: variadic ? Infinity : params.length }
}

const qualify = (name) => {
  const clean = name.replaceAll('"', '').toLowerCase()
  return clean.includes('.') ? clean : `public.${clean}`
}

const parseFile = (sql, file) => {
  const text = mask(sql)
  const entries = []
  for (const hit of text.matchAll(definitionPattern)) {
    const open = hit.index + hit[0].length - 1
    const close = closingParen(text, open)
    const signature = text.slice(open + 1, close)
    const quote = text.slice(close).match(/\bAS\s+(\$\w*\$)/i)
    if (!quote) continue
    const bodyStart = close + quote.index + quote[0].length
    const bodyEnd = text.indexOf(quote[1], bodyStart)
    if (bodyEnd === -1) continue
    const name = qualify(hit[1])
    const types = splitTopLevel(signature)
      .filter((param) => !/^\s*OUT\b/i.test(param))
      .map((param) => param.replace(/\bDEFAULT\b[\s\S]*|=[\s\S]*/i, '').trim().split(/\s+/).at(-1).toLowerCase())
    entries.push({
      at: hit.index,
      type: 'function',
      id: `${name}(${types.join(',')})`,
      name,
      params: parameterRange(signature),
      body: text.slice(bodyStart, bodyEnd),
      bodyLine: lineAt(text, bodyStart),
      file,
      line: lineAt(text, hit.index),
      source: sql.slice(hit.index, bodyEnd + quote[1].length),
    })
  }
  for (const hit of text.matchAll(triggerPattern)) {
    const events = hit[2].toLowerCase()
    entries.push({
      at: hit.index,
      type: 'trigger',
      key: `${tableName(hit[3])}.${hit[1].toLowerCase()}`,
      table: tableName(hit[3]),
      ops: ['insert', 'update', 'delete'].filter((op) => events.includes(op)),
      fn: qualify(hit[4]),
      file,
      line: lineAt(text, hit.index),
      source: sql.slice(hit.index, text.indexOf(';', hit.index) + 1),
    })
  }
  for (const hit of text.matchAll(dropTriggerPattern)) entries.push({ at: hit.index, type: 'drop-trigger', key: `${tableName(hit[2])}.${hit[1].toLowerCase()}` })
  for (const hit of text.matchAll(dropFunctionPattern)) {
    const open = hit.index + hit[0].length - 1
    const types = splitTopLevel(text.slice(open + 1, closingParen(text, open)))
      .filter((param) => !/^\s*OUT\b/i.test(param))
      .map((param) => param.trim().split(/\s+/).at(-1).toLowerCase())
    entries.push({ at: hit.index, type: 'drop-function', id: `${qualify(hit[1])}(${types.join(',')})` })
  }
  return entries.sort((a, b) => a.at - b.at)
}

const sqlFiles = (target) =>
  statSync(target).isDirectory()
    ? readdirSync(target, { withFileTypes: true })
        .flatMap((entry) => sqlFiles(path.join(target, entry.name)))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)) || a.localeCompare(b))
    : target.endsWith('.sql')
      ? [target]
      : []

const replay = (targets, { through, root = process.cwd() }) => {
  const functions = new Map()
  const triggers = new Map()
  for (const target of targets) {
    for (const file of sqlFiles(target)) {
      const base = path.basename(file)
      if (through && /^\d{14}_/.test(base) && base.slice(0, 14) > through) continue
      for (const entry of parseFile(readFileSync(file, 'utf8'), path.relative(root, file))) {
        if (entry.type === 'function') functions.set(entry.id, entry)
        else if (entry.type === 'drop-function') functions.delete(entry.id)
        else if (entry.type === 'trigger') triggers.set(entry.key, entry)
        else triggers.delete(entry.key)
      }
    }
  }
  return { functions, triggers }
}

export const readSources = ({ functions, triggers = functions, through, root }) => ({
  functions: replay(functions, { through, root }).functions,
  triggers: replay(triggers, { through, root }).triggers,
})

const mapSteps = (steps, change) =>
  steps.map((step) => {
    if (step.call) return { call: mapSteps(step.call, change) }
    if (step.branches) return change({ ...step, branches: step.branches.map((branch) => mapSteps(branch, change)) })
    return change(step)
  })

export const extract = (sources) => {
  const { functions, triggers } = readSources(sources)
  const byName = new Map()
  for (const definition of functions.values()) byName.set(definition.name, [...(byName.get(definition.name) ?? []), definition])
  const names = [...new Set([...byName.keys()].map((name) => name.split('.')[1]))]
  const callPattern = new RegExp(`(?<![\\w.])((?:public|private|analytics)\\.)?(${names.join('|') || '(?!)'})\\s*\\(`, 'gi')
  const prefix = (where) => (step) => {
    if (step.branches) return step.condition ? { ...step, condition: `${where} ${step.condition}` } : step
    return step.via ? { ...step, via: [where, ...step.via] } : step
  }
  const inline = (steps, where) => [{ call: mapSteps(steps, prefix(where)) }]

  const resolved = new Map()
  const resolve = (definition, stack) => {
    if (resolved.has(definition.id)) return resolved.get(definition.id)
    if (stack.includes(definition.id)) return []
    const inner = [...stack, definition.id]
    const code = blankStrings(definition.body)
    const site = (line) => `${definition.file}:${definition.bodyLine + line - 1}`
    const items = ownEvents(definition.body).map((event) => {
      if (event.end) return { at: event.at, steps: [{ end: event.end }] }
      const steps = event.lock ? [{ ...event.lock, ...(event.lock.row ? { row: `${definition.id} ${event.lock.row}` } : {}), via: [site(event.line)] }] : []
      for (const trigger of event.dml ? triggers.values() : []) {
        if (trigger.table !== event.dml.table || !trigger.ops.includes(event.dml.op)) continue
        const handler = byName.get(trigger.fn)?.[0]
        if (handler) steps.push(...inline(resolve(handler, inner), `${site(event.line)} trigger ${trigger.key}`))
      }
      return { at: event.at, steps }
    })
    for (const hit of code.matchAll(callPattern)) {
      const name = `${(hit[1] ?? 'public.').toLowerCase()}${hit[2].toLowerCase()}`
      const candidates = byName.get(name) ?? (hit[1] ? null : byName.get(`private.${hit[2].toLowerCase()}`))
      if (!candidates) continue
      const open = hit.index + hit[0].length - 1
      const count = splitTopLevel(definition.body.slice(open + 1, closingParen(definition.body, open))).length
      const fits = candidates.filter((candidate) => count >= candidate.params.min && count <= candidate.params.max)
      const options = (fits.length ? fits : candidates).map((candidate) => resolve(candidate, inner)).filter((steps) => steps.length)
      if (!options.length) continue
      const where = site(lineAt(definition.body, hit.index))
      items.push({ at: hit.index, steps: options.length === 1 ? inline(options[0], where) : [{ branches: options.map((steps) => inline(steps, where)) }] })
    }
    const steps = mapSteps(buildTree(code, items), (step) => (step.condition ? { ...step, condition: `${definition.id} ${step.condition}` } : step))
    resolved.set(definition.id, steps)
    return steps
  }

  return Object.fromEntries(
    [...functions.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((definition) => [definition.id, { file: definition.file, line: definition.line, steps: resolve(definition, []) }])
      .filter(([, entry]) => entry.steps.length),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (flag) => {
    const at = args.indexOf(flag)
    return at === -1 ? undefined : args.splice(at, 2)[1]
  }
  const through = option('--through')
  const triggers = option('--triggers')
  if (!args.length) {
    console.error('Usage: extract.mjs <function sql file or dir>... [--triggers <sql dir>] [--through <14-digit migration prefix>]')
    process.exit(2)
  }
  console.log(JSON.stringify(extract({ functions: args, triggers: triggers ? [triggers] : args, through }), null, 2))
}

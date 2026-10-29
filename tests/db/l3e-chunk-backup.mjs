import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function chunkBackup(source, size = 1000) {
  assert.ok(Number.isSafeInteger(size) && size > 0)
  const pattern = /^(INSERT INTO "[a-z_]+"\."[a-z_]+" \([^\n]*\) VALUES)\s*/gm
  const output = [], hash = createHash('sha256')
  let cursor = 0, rows = 0, statements = 0
  for (let match; (match = pattern.exec(source));) {
    output.push(source.slice(cursor, match.index))
    const header = match[1], tuples = []
    let depth = 0, quote = '', escapes = false, start = -1, end = pattern.lastIndex
    const flush = () => {
      if (!tuples.length) return
      output.push(`${header}\n${tuples.join(',\n')};`)
      tuples.length = 0
      statements++
    }
    for (; end < source.length; end++) {
      const char = source[end]
      if (quote) {
        if (escapes && char === '\\') { end++; continue }
        if (char === quote) {
          if (source[end + 1] === quote) end++
          else quote = ''
        }
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        escapes = char === "'" && /[eE]/.test(source[end - 1] ?? '') && !/[a-zA-Z0-9_$]/.test(source[end - 2] ?? '')
      } else if (char === '(') {
        if (depth++ === 0) start = end
      } else if (char === ')') {
        assert.ok(depth > 0, 'Unbalanced backup tuple')
        if (--depth === 0) {
          const tuple = source.slice(start, end + 1)
          tuples.push(tuple)
          hash.update(tuple)
          rows++
          if (tuples.length === size) { flush(); output.push('\n') }
        }
      } else if (char === ';' && depth === 0) {
        flush()
        end++
        break
      } else if (depth === 0) assert.match(char, /[\s,]/, 'Unexpected backup INSERT suffix')
    }
    assert.equal(depth, 0)
    assert.equal(quote, '')
    assert.ok(end <= source.length && source[end - 1] === ';', 'Unterminated backup INSERT')
    cursor = end
    pattern.lastIndex = end
  }
  output.push(source.slice(cursor))
  return { sql: output.join(''), rows, statements, valuesSha256: hash.digest('hex') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { labRoot, project, requireMini, json } = await import('../../scripts/perf-lab/common.mjs')
  await requireMini()
  assert.equal(project, 'pt4bafablesq')
  const file = path.join(labRoot, 'backup-staging/data.sql')
  const source = await readFile(file, 'utf8')
  const result = chunkBackup(source)
  const verified = chunkBackup(result.sql, Number.MAX_SAFE_INTEGER)
  assert.equal(verified.rows, result.rows)
  assert.equal(verified.valuesSha256, result.valuesSha256)
  assert.ok(result.rows > 245000)
  await writeFile(`${file}.tmp`, result.sql)
  await rename(`${file}.tmp`, file)
  await json(path.join(labRoot, 'backup-chunks.json'), { rows: result.rows, statements: result.statements, valuesSha256: result.valuesSha256, sourceSha256: createHash('sha256').update(source).digest('hex'), chunkedSha256: createHash('sha256').update(result.sql).digest('hex'), maximumRows: 1000 })
  console.log(JSON.stringify({ rows: result.rows, statements: result.statements, maximumRows: 1000 }))
}

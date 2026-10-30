import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'

export function splitBackupInserts(source, limit = 1000) {
    assert.ok(Number.isInteger(limit) && limit > 0)
    const expression =
        /^INSERT INTO ("[a-z_]+"\."[a-z_]+")\s*\([^;]+?\)\s*(?:OVERRIDING SYSTEM VALUE\s+)?VALUES\s*/gm
    const chunks = []
    const counts = {}
    const rowHash = createHash('sha256')
    let copied = 0
    for (let match; (match = expression.exec(source)); ) {
        assert.ok(match.index >= copied)
        chunks.push(source.slice(copied, match.index))
        const header = match[0]
        const rows = []
        let cursor = expression.lastIndex
        for (;;) {
            while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++
            assert.equal(source[cursor], '(', `Unexpected row in ${match[1]}`)
            const start = cursor
            let depth = 0
            do {
                const char = source[cursor++]
                if (char === "'" || char === '"') {
                    const escaped =
                        char === "'" &&
                        /(?:^|[^\w])e$/i.test(source.slice(Math.max(0, cursor - 3), cursor - 1))
                    for (;;) {
                        assert.ok(cursor < source.length, 'Unclosed SQL string')
                        if (escaped && source[cursor] === '\\') cursor += 2
                        else if (source[cursor] === char && source[cursor + 1] === char) cursor += 2
                        else if (source[cursor++] === char) break
                    }
                } else if (char === '$') {
                    const delimiter = /^\$[a-z_0-9]*\$/i.exec(source.slice(cursor - 1))?.[0]
                    if (delimiter) {
                        const end = source.indexOf(delimiter, cursor - 1 + delimiter.length)
                        assert.ok(end >= 0, 'Unclosed SQL dollar string')
                        cursor = end + delimiter.length
                    }
                } else if (char === '(') depth++
                else if (char === ')') depth--
                assert.ok(cursor <= source.length && depth >= 0, 'Unclosed SQL row')
            } while (depth)
            const row = source.slice(start, cursor)
            rows.push(row)
            rowHash.update(row).update('\0')
            counts[match[1]] = (counts[match[1]] ?? 0) + 1
            while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++
            const separator = source[cursor++]
            assert.ok(
                separator === ',' || separator === ';',
                `Unsupported INSERT suffix in ${match[1]}`,
            )
            if (rows.length === limit || separator === ';') {
                chunks.push(`${header}${rows.join(',\n')};\n`)
                rows.length = 0
            }
            if (separator === ';') break
        }
        copied = cursor
        expression.lastIndex = cursor
    }
    chunks.push(source.slice(copied))
    assert.ok(Object.keys(counts).length)
    return { sql: chunks.join(''), counts, rowsSha256: rowHash.digest('hex') }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    await requireMini()
    const filename = path.join(labRoot, 'backup/data.sql')
    const source = await readFile(filename, 'utf8')
    const result = splitBackupInserts(source)
    const verification = splitBackupInserts(result.sql)
    assert.deepEqual(verification.counts, result.counts)
    assert.equal(verification.rowsSha256, result.rowsSha256)
    const hash = (value) => createHash('sha256').update(value).digest('hex')
    await writeFile(
        path.join(labRoot, 'recovery-backup.json'),
        JSON.stringify(
            {
                originalSha256: hash(source),
                preparedSha256: hash(result.sql),
                rowsSha256: result.rowsSha256,
                rows: result.counts,
            },
            null,
            2,
        ),
    )
    await writeFile(`${filename}.prepared`, result.sql)
    await rename(`${filename}.prepared`, filename)
    console.log(`Prepared bounded INSERT batches for ${Object.keys(result.counts).length} tables`)
}

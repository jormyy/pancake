import assert from 'node:assert/strict'

export function batchBackupInserts(source, limit = 200) {
    assert.ok(Number.isInteger(limit) && limit > 0)
    const output = []
    let offset = 0
    for (const match of source.matchAll(/^INSERT INTO [^\n]+ VALUES\n/gm)) {
        const header = match[0]
        const start = match.index + header.length
        output.push(source.slice(offset, start))
        let chunk = start, depth = 0, quoted = false, rows = 1, ended = false
        for (let index = start; index < source.length; index++) {
            const char = source[index]
            if (char === "'") {
                if (quoted && source[index + 1] === "'") index++
                else quoted = !quoted
                continue
            }
            if (quoted) continue
            if (char === '(') depth++
            if (char === ')') depth--
            if (depth !== 0) continue
            if (char === ',') {
                if (rows === limit) {
                    output.push(source.slice(chunk, index), ';\n', header)
                    chunk = index + 1
                    rows = 0
                }
                rows++
            }
            if (char === ';') {
                output.push(source.slice(chunk, index + 1))
                offset = index + 1
                ended = true
                break
            }
        }
        assert.ok(ended, 'Backup insert must have a complete SQL statement')
    }
    output.push(source.slice(offset))
    return output.join('')
}

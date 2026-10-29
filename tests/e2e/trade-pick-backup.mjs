import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export function extractTradePickTables(data) {
    const tables = new Set(['leagues', 'league_members', 'league_seasons', 'players', 'roster_players', 'draft_picks', 'trades', 'trade_participants', 'trade_items', 'league_activity', 'roster_transactions'])
    const statements = []
    for (const match of data.matchAll(/^INSERT INTO "public"\."([^"]+)"[^\n]*\n/gm)) {
        if (!tables.has(match[1])) continue
        let quoted = false
        let end = match.index
        for (; end < data.length; end++) {
            if (data[end] === "'") {
                if (quoted && data[end + 1] === "'") { end++; continue }
                quoted = !quoted
            }
            if (!quoted && data[end] === ';') break
        }
        assert.ok(end < data.length)
        statements.push(data.slice(match.index, end + 1))
    }
    assert.equal(statements.length, tables.size)
    return `SET session_replication_role = replica;\n${statements.join('\n')}\nSET session_replication_role = origin;\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
        const [source, destination] = process.argv.slice(2)
        assert.ok(source && destination)
        writeFileSync(destination, extractTradePickTables(readFileSync(source, 'utf8')), { mode: 0o600 })
        console.log('Extracted public trade tables without auth tables or credentials.')
}

import { expect, it } from 'vitest'
import { batchBackupInserts } from './e2e/ui-polish-backup.mjs'

it('batches dump inserts without changing quoted commas, newlines, parentheses, or doubled quotes', () => {
    const header = 'INSERT INTO "public"."players" ("id", "name") VALUES\n'
    const rows = ["(1,'Name, One')", "(2,'O''Neal;\n(hello)')", "(3,'Name Three')"]
    const tail = '\nRESET ALL;\n'
    const source = `${header}${rows.join(',\n')};${tail}`
    expect(batchBackupInserts(source, 2)).toBe(`${header}${rows.slice(0, 2).join(',\n')};\n${header}\n${rows[2]};${tail}`)
    expect(batchBackupInserts(source, 3)).toBe(source)
})
it('rejects a partial dump before starting a database', () => {
    expect(() => batchBackupInserts('INSERT INTO "public"."players" ("name") VALUES\n(\'partial')).toThrow('complete SQL statement')
})

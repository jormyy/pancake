import { expect, it } from 'vitest'
import { splitBackupInserts } from './e2e/l5c-recovery-backup.mjs'

it('bounds restore statements without changing quoted rows or identity overrides', () => {
    const source = `SET standard_conforming_strings=on;
INSERT INTO "public"."fixture" ("id", "text") OVERRIDING SYSTEM VALUE VALUES
(1, 'a,b;(x)'),
(2, 'O''Neil'),
(3, $$nested, ('text');$$),
(4, E'escaped\\\'quote'),
(5, json_build_object('key', ARRAY[1,2]));
SELECT setval('sequence', 5);
INSERT INTO "public"."fixture" ("id", "text") VALUES (6, 'next');`
    const bounded = splitBackupInserts(source, 2)
    const repeated = splitBackupInserts(bounded.sql, 1)
    expect(bounded.counts).toEqual({ '"public"."fixture"': 6 })
    expect(repeated.counts).toEqual(bounded.counts)
    expect(repeated.rowsSha256).toBe(bounded.rowsSha256)
    expect(bounded.sql.match(/OVERRIDING SYSTEM VALUE VALUES/g)).toHaveLength(3)
    expect(bounded.sql).toContain("SELECT setval('sequence', 5);")
    expect(bounded.sql).toContain("(4, E'escaped\\\'quote')")
})

it('rejects unsupported conflict clauses instead of silently dropping them', () => {
    expect(() => splitBackupInserts('INSERT INTO "public"."fixture" ("id") VALUES (1) ON CONFLICT DO NOTHING;')).toThrow('Unsupported INSERT suffix')
})

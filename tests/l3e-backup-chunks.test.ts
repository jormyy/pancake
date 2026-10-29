import { expect, it } from 'vitest'
import { chunkBackup } from './db/l3e-chunk-backup.mjs'

it('preserves tuple bytes and surrounding commands across bounded INSERTs', () => {
  const source = 'SET x=1;\nINSERT INTO "public"."players" (id,name) VALUES\n(1,\'a,(b)\'),\n(2,\'c;d\'),\n(3,\'it\'\'s\');\nSELECT 1;\n'
  const result = chunkBackup(source, 2)
  expect(result.rows).toBe(3)
  expect(result.statements).toBe(2)
  expect(result.sql.startsWith('SET x=1;\n')).toBe(true)
  expect(result.sql.endsWith('\nSELECT 1;\n')).toBe(true)
  expect(chunkBackup(result.sql, 1).valuesSha256).toBe(result.valuesSha256)
})

it('handles escaped quotes and nested value expressions', () => {
  const source = String.raw`INSERT INTO "public"."players" (name,n) VALUES
(E'a\'b,(x)',round(1.5)),('second',2);`
  const result = chunkBackup(source, 1)
  expect(result.rows).toBe(2)
  expect(result.statements).toBe(2)
  expect(chunkBackup(result.sql).valuesSha256).toBe(result.valuesSha256)
})

it('rejects incomplete statements instead of writing a partial restore', () => {
  expect(() => chunkBackup('INSERT INTO "public"."players" (id) VALUES\n(1), (2')).toThrow()
})

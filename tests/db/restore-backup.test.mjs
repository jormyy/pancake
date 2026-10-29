import assert from 'node:assert/strict'
import test from 'node:test'
import { backupInserts, restoreBackup } from '../../scripts/db-health/restore-backup.mjs'

test('backup import keeps application rows and required users without importing sessions', () => {
  const source = `INSERT INTO "auth"."users" ("id") VALUES
('user');

INSERT INTO "auth"."sessions" ("id") VALUES
('private-session');

INSERT INTO "public"."players" ("id", "display_name") VALUES
('player', 'Name; with punctuation');

-- End
`
  assert.deepEqual(backupInserts(source).map(row => row.relation), ['auth.users', 'public.players'])
  assert.deepEqual(backupInserts(source)[1].columns, ['id', 'display_name'])
  assert.match(backupInserts(source)[1].statement, /Name; with punctuation/)
  assert.ok(!backupInserts(source)[1].statement.includes('-- End'))
})

test('backup import rejects a truncated INSERT', () => {
  assert.throws(() => backupInserts('INSERT INTO "public"."players" ("id") VALUES\n(1)'))
})

test('backup restore rejects another target or an unprivileged role before reading data', () => {
  assert.throws(() => restoreBackup('postgresql://supabase_admin@127.0.0.1:58922/postgres', '/never-read', '/never-written'))
  assert.throws(() => restoreBackup('postgresql://postgres@127.0.0.1:57422/postgres', '/never-read', '/never-written'))
})

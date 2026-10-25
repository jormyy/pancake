import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { latestFunctionDefinitionsInSource } from '../../scripts/check-db-function-sources.mjs'

const db = process.env.SUPABASE_DB_URL
assert.ok(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const migration = readFileSync('supabase/migrations/20261026000700_taxi_and_server_rules.sql', 'utf8')
const prefix = migration.slice(0, migration.indexOf('ALTER TABLE public.leagues ALTER COLUMN taxi_rule'))
const definition = latestFunctionDefinitionsInSource(prefix).get('private.notif_league_trigger') ?? ''
const update = prefix.match(/UPDATE public\.leagues SET taxi_rule='rookies_or_64_games'[^;]*;/)?.[0]
assert.ok(update)
const setup = readFileSync('tests/db/rules-support.sql', 'utf8')
const sql = `BEGIN;
${setup}
CREATE TEMP TABLE fixture AS SELECT * FROM pg_temp.rules_fixture(2,9557);
UPDATE leagues SET taxi_rule='drafted_rookies' WHERE id=(SELECT league_id FROM fixture);
DELETE FROM notification_outbox WHERE event_type='league_settings_changed';
${definition}
${update}
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_outbox WHERE event_type='league_settings_changed'), 'taxi rule backfill enqueues no settings notifications');
UPDATE leagues SET name='Changed setting' WHERE id=(SELECT league_id FROM fixture);
SELECT pg_temp.check_rules((SELECT count(*)=2 FROM notification_outbox WHERE event_type='league_settings_changed'), 'ordinary league settings still enqueue notifications');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;`
console.log(execFileSync('psql', [db, '-Xv', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }))

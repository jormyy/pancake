import { strict as assert } from 'node:assert'

const db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(db)
const target = new URL(db)
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.port === '57822', 'Only the notification lane database is allowed')
const migration = await Deno.readTextFile('supabase/migrations/20261020000160_notification_preferences_delivery.sql')
const sql = `BEGIN;
CREATE TEMP TABLE notif_legacy_users(user_id uuid, mask int);
INSERT INTO notif_legacy_users SELECT gen_random_uuid(),mask FROM generate_series(0,15) mask;
INSERT INTO auth.users(id,email,raw_user_meta_data)
SELECT user_id,user_id::text || '@example.test',jsonb_build_object('username',user_id::text) FROM notif_legacy_users;
INSERT INTO notification_preferences(user_id,trade_enabled,waiver_enabled,draft_enabled,activity_enabled)
SELECT user_id,(mask&1)>0,(mask&2)>0,(mask&4)>0,(mask&8)>0 FROM notif_legacy_users;
ALTER TABLE notification_preferences DROP COLUMN master_enabled,DROP COLUMN category_settings,DROP COLUMN event_settings;
ALTER TABLE notification_outbox DROP COLUMN suppressed_at,DROP COLUMN suppression_reason,DROP COLUMN web_attempted_at,DROP COLUMN web_delivered_at,DROP COLUMN web_failed_at;
DROP TABLE notif_event_catalog;
${migration}
DO $$
DECLARE r record; e record; expected boolean;
BEGIN
  FOR r IN SELECT * FROM notif_legacy_users LOOP
    FOR e IN SELECT * FROM notif_event_catalog LOOP
      expected := e.default_enabled AND CASE e.legacy_column WHEN 'trade_enabled' THEN (r.mask&1)>0
        WHEN 'waiver_enabled' THEN (r.mask&2)>0 WHEN 'draft_enabled' THEN (r.mask&4)>0 ELSE (r.mask&8)>0 END;
      IF private.notif_preference_enabled(r.user_id,e.event_type,e.category) IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'legacy mask % event % changed choice',r.mask,e.event_type;
      END IF;
      IF (SELECT (category_settings->>e.category)::boolean FROM notification_preferences WHERE user_id = r.user_id)
        IS DISTINCT FROM (CASE e.legacy_column WHEN 'trade_enabled' THEN (r.mask&1)>0
          WHEN 'waiver_enabled' THEN (r.mask&2)>0 WHEN 'draft_enabled' THEN (r.mask&4)>0 ELSE (r.mask&8)>0 END) THEN
        RAISE EXCEPTION 'legacy category mapping failed for mask % event %',r.mask,e.event_type;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'all 16 legacy combinations preserve every event and category';
END $$;
ROLLBACK;`
const child = new Deno.Command('psql', { args: [db, '-X', '--set', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'inherit', stderr: 'inherit' }).spawn()
await new Response(sql).body!.pipeTo(child.stdin)
Deno.exit((await child.status).code)

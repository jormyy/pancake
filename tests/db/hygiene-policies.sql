BEGIN;
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('leagues','leagues_update'),
    ('lineup_slot_templates','slot_templates_delete'),
    ('lineup_slot_templates','slot_templates_insert'),
    ('lineup_slot_templates','slot_templates_update'),
    ('rps_challenges','rps_insert'),
    ('rps_challenges','rps_update'),
    ('trade_block_items','trade_block_items_delete_own'),
    ('trade_block_items','trade_block_items_insert_own'),
    ('trade_block_items','trade_block_items_update_own'),
    ('trade_items','trade_items_insert'),
    ('trade_vetos','trade_vetos_insert'),
    ('trades','trades_insert'),
    ('trades','trades_update')
  ) AS removed(table_name,policy_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename=target.table_name AND policyname=target.policy_name) THEN
      RAISE EXCEPTION 'Dead write policy %.% remains',target.table_name,target.policy_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='league_members' AND policyname='league_members_update')
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='profiles' AND policyname='profiles_update') THEN
    RAISE EXCEPTION 'Supported direct edits lose their row policies';
  END IF;
END $$;
ROLLBACK;

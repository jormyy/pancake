\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE private.stats_fk_probe(stat_id uuid,game_id uuid,CONSTRAINT stats_fk_probe_fk FOREIGN KEY(stat_id,game_id) REFERENCES public.player_game_stats(id,game_id) DEFERRABLE INITIALLY DEFERRED);
INSERT INTO private.stats_fk_probe SELECT id,game_id FROM public.player_game_stats LIMIT 1;
SET CONSTRAINTS ALL IMMEDIATE;
CREATE TABLE private.stats_unvalidated_probe(stat_id uuid,game_id uuid);
INSERT INTO private.stats_unvalidated_probe VALUES(gen_random_uuid(),gen_random_uuid());
ALTER TABLE private.stats_unvalidated_probe ADD CONSTRAINT stats_unvalidated_fk FOREIGN KEY(stat_id,game_id) REFERENCES public.player_game_stats(id,game_id) NOT VALID;
CREATE PUBLICATION unpartition_probe_publication FOR TABLE public.player_game_stats WITH (publish_via_partition_root=true);
CREATE INDEX unpartition_probe_idx ON public.player_game_stats(assists);
COMMENT ON INDEX public.unpartition_probe_idx IS 'Preserve index comment';
COMMENT ON TABLE public.player_game_stats IS 'Preserve table comment';
COMMENT ON COLUMN public.player_game_stats.points IS 'Preserve column comment';
COMMENT ON CONSTRAINT player_game_stats_player_id_fkey ON public.player_game_stats IS 'Preserve foreign key comment';
COMMENT ON TRIGGER trade_input_insert ON public.player_game_stats IS 'Preserve transition trigger comment';
COMMENT ON POLICY player_game_stats_select ON public.player_game_stats IS 'Preserve policy comment';
GRANT SELECT(points) ON public.player_game_stats TO anon;
CREATE FUNCTION private.unpartition_probe(player public.player_game_stats) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT player.id $$;
REVOKE ALL ON FUNCTION private.unpartition_probe(public.player_game_stats) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.unpartition_probe(public.player_game_stats) TO authenticated;
COMMENT ON FUNCTION private.unpartition_probe(public.player_game_stats) IS 'Preserve row type function';
CREATE VIEW public.unpartition_probe_view AS SELECT private.unpartition_probe(player) AS id FROM public.player_game_stats player;
COMMENT ON VIEW public.unpartition_probe_view IS 'Preserve dependent view';
:migration_body
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_publication_rel r JOIN pg_publication p ON p.oid=r.prpubid WHERE p.pubname='unpartition_probe_publication' AND r.prrelid='public.player_game_stats'::regclass) THEN RAISE EXCEPTION 'Publication loses stats'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='private.stats_unvalidated_probe'::regclass AND confrelid='public.player_game_stats'::regclass AND NOT convalidated) THEN RAISE EXCEPTION 'An unvalidated foreign key changes state'; END IF;
  IF (SELECT relkind FROM pg_class WHERE oid='public.player_game_stats'::regclass)<>'r' THEN RAISE EXCEPTION 'Stats remain partitioned'; END IF;
  IF obj_description('public.player_game_stats'::regclass,'pg_class')<>'Preserve table comment' THEN RAISE EXCEPTION 'Table comment changed'; END IF;
  IF col_description('public.player_game_stats'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='public.player_game_stats'::regclass AND attname='points'))<>'Preserve column comment' THEN RAISE EXCEPTION 'Column comment changed'; END IF;
  IF obj_description('public.unpartition_probe_idx'::regclass,'pg_class')<>'Preserve index comment' THEN RAISE EXCEPTION 'Index comment changed'; END IF;
  IF obj_description('public.unpartition_probe_view'::regclass,'pg_class')<>'Preserve dependent view' THEN RAISE EXCEPTION 'View comment changed'; END IF;
  IF NOT has_column_privilege('anon','public.player_game_stats','points','SELECT') THEN RAISE EXCEPTION 'Column grant changed'; END IF;
  IF has_function_privilege('anon','private.unpartition_probe(public.player_game_stats)','EXECUTE') OR NOT has_function_privilege('authenticated','private.unpartition_probe(public.player_game_stats)','EXECUTE') THEN RAISE EXCEPTION 'Row type function grants changed'; END IF;
  IF obj_description('private.unpartition_probe(public.player_game_stats)'::regprocedure,'pg_proc')<>'Preserve row type function' THEN RAISE EXCEPTION 'Function comment changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='private.stats_fk_probe'::regclass AND confrelid='public.player_game_stats'::regclass AND condeferrable AND condeferred AND convalidated) THEN RAISE EXCEPTION 'Incoming foreign key changed'; END IF;
  IF EXISTS(SELECT 1 FROM private.stats_fk_probe f LEFT JOIN public.unpartition_probe_view v ON v.id=f.stat_id WHERE v.id IS NULL) THEN RAISE EXCEPTION 'View remains bound to old rows'; END IF;
  IF (SELECT obj_description(oid,'pg_trigger') FROM pg_trigger WHERE tgrelid='public.player_game_stats'::regclass AND tgname='trade_input_insert')<>'Preserve transition trigger comment' THEN RAISE EXCEPTION 'Trigger comment changed'; END IF;
  IF (SELECT obj_description(oid,'pg_policy') FROM pg_policy WHERE polrelid='public.player_game_stats'::regclass AND polname='player_game_stats_select')<>'Preserve policy comment' THEN RAISE EXCEPTION 'Policy comment changed'; END IF;
END;
$$;
SELECT 'Row data, indexes, comments, grants, foreign keys, triggers, and dependent objects survive the rebuild' AS result;
ROLLBACK;

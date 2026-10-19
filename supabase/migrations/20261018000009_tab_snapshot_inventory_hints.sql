SET lock_timeout = '5s';
SET statement_timeout = '2min';

ALTER TABLE public.league_change_hints DROP CONSTRAINT league_change_hints_topic_check,
  ADD CONSTRAINT league_change_hints_topic_check CHECK(topic IN ('lineup','roster','score','game','stat','inventory'));

CREATE OR REPLACE FUNCTION private.emit_league_inventory_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_change record;
BEGIN
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM new_rows n JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
      UNION ALL SELECT o.* FROM old_rows o JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s) SELECT DISTINCT changed.league_id FROM changed
      JOIN public.leagues league ON league.id=changed.league_id AND league.deleted_at IS NULL
      ORDER BY changed.league_id
  $query$,v_rows) LOOP
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes)
      VALUES(v_change.league_id,'inventory',1,NULL)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,updated_at=clock_timestamp();
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.emit_league_inventory_change() FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER compact_inventory_insert AFTER INSERT ON public.draft_picks
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_update AFTER UPDATE ON public.draft_picks
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_delete AFTER DELETE ON public.draft_picks
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_insert AFTER INSERT ON public.waiver_claims
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_update AFTER UPDATE ON public.waiver_claims
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_delete AFTER DELETE ON public.waiver_claims
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_insert AFTER INSERT ON public.waiver_priorities
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_update AFTER UPDATE ON public.waiver_priorities
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_delete AFTER DELETE ON public.waiver_priorities
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_insert AFTER INSERT ON public.waiver_wire_log
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_update AFTER UPDATE ON public.waiver_wire_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_delete AFTER DELETE ON public.waiver_wire_log
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_insert AFTER INSERT ON public.faab_balances
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_update AFTER UPDATE ON public.faab_balances
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_delete AFTER DELETE ON public.faab_balances
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_insert AFTER INSERT ON public.league_seasons
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_update AFTER UPDATE ON public.league_seasons
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_delete AFTER DELETE ON public.league_seasons
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

RESET statement_timeout;
RESET lock_timeout;

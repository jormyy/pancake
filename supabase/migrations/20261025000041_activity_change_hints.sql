CREATE TRIGGER compact_inventory_insert AFTER INSERT ON public.league_activity
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_update AFTER UPDATE ON public.league_activity
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE TRIGGER compact_inventory_delete AFTER DELETE ON public.league_activity
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_inventory_change();

CREATE OR REPLACE FUNCTION private.prevent_locked_lineup_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data public.weekly_lineups%ROWTYPE; lock_reason text;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.member_id, OLD.league_id, OLD.league_season_id, OLD.player_id, OLD.game_date, OLD.slot_type)
    IS NOT DISTINCT FROM (NEW.member_id, NEW.league_id, NEW.league_season_id, NEW.player_id, NEW.game_date, NEW.slot_type) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN row_data := NEW; ELSE row_data := OLD; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(row_data.league_id::text), hashtext(row_data.member_id::text));
  SELECT locked.reason INTO lock_reason
    FROM private.locked_assets(row_data.league_id, row_data.league_season_id, row_data.member_id) locked
    WHERE locked.asset_kind = 'player' AND locked.asset_id = row_data.player_id
      AND NOT (locked.source_kind='trade' AND private.trade_lifecycle_write_active()
        AND EXISTS (SELECT 1 FROM private.taxi_acquisition_context context JOIN public.trades trade ON trade.id=context.related_id
          WHERE context.transaction_id=pg_current_xact_id() AND context.source='trade'
            AND context.league_id=row_data.league_id AND context.league_season_id=row_data.league_season_id
            AND context.player_id=row_data.player_id AND context.related_id=locked.source_id AND trade.status='accepted'))
    ORDER BY locked.source_kind, locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE = 'PA004'; END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT locked.reason INTO lock_reason
      FROM private.locked_assets(NEW.league_id, NEW.league_season_id, NEW.member_id) locked
      WHERE locked.asset_kind = 'player' AND locked.asset_id = NEW.player_id
      ORDER BY locked.source_kind, locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE = 'PA004'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

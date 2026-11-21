-- Canonical SQL source for private.guard_accepted_trade_capacity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_accepted_trade_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_member uuid;
  v_league uuid;
  v_season uuid;
  v_baseline jsonb;
  v_member_baseline jsonb;
  v_txid text := txid_current()::text;
BEGIN
  v_baseline := COALESCE(NULLIF(current_setting('pancake.trade_hold_baseline', true), ''), '{}')::jsonb;
  FOR v_league,v_season,v_member IN
    SELECT DISTINCT league_id,league_season_id,member_id FROM (
      SELECT OLD.league_id,OLD.league_season_id,OLD.member_id WHERE TG_OP<>'INSERT'
      UNION ALL SELECT NEW.league_id,NEW.league_season_id,NEW.member_id WHERE TG_OP<>'DELETE'
    ) affected ORDER BY league_id,member_id,league_season_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_league::text),hashtext(v_member::text));
    IF TG_WHEN='AFTER' THEN
      PERFORM private.assert_accepted_trade_capacity(v_league,v_season,v_member);
      v_baseline := v_baseline || jsonb_build_object(v_member::text,
        COALESCE(v_baseline->(v_member::text), '{}'::jsonb) || jsonb_build_object('checked', true));
      PERFORM set_config('pancake.trade_hold_baseline', v_baseline::text, true);
    ELSIF COALESCE(v_baseline->(v_member::text)->>'txid','') <> v_txid
       OR COALESCE((v_baseline->(v_member::text)->>'checked')::boolean, false) THEN
      SELECT jsonb_object_agg(counts.trade_id::text, jsonb_build_object('active', counts.active, 'ir', counts.ir, 'taxi', counts.taxi))
        INTO v_member_baseline
        FROM private.trade_hold_counts(v_league, v_season, v_member, NULL) counts;
      v_baseline := v_baseline || jsonb_build_object(v_member::text,
        jsonb_build_object('txid', v_txid, 'checked', false, 'counts', COALESCE(v_member_baseline, '{}'::jsonb)));
      PERFORM set_config('pancake.trade_hold_baseline', v_baseline::text, true);
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

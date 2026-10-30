-- Canonical SQL source for private.reconcile_future_picks.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.reconcile_future_picks(p_league_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_year int;
  v_years smallint;
  v_reference record;
  v_predicate text := '';
BEGIN
  SELECT league.future_pick_years,season.season_year INTO v_years,v_year
  FROM public.leagues league JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
  WHERE league.id=p_league_id FOR UPDATE OF league;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT p_league_id,year_value,round_value,member.id,member.id
  FROM public.league_members member
  CROSS JOIN generate_series(v_year+1,v_year+v_years) year_value
  CROSS JOIN generate_series(1,3) round_value
  WHERE member.league_id=p_league_id
  ON CONFLICT(league_id,season_year,round,original_owner_id) DO NOTHING;

  PERFORM 1 FROM public.draft_picks pick
  WHERE pick.league_id=p_league_id AND pick.season_year>v_year+v_years
    AND pick.current_owner_id=pick.original_owner_id AND NOT pick.is_used
    AND pick.used_at IS NULL AND pick.rookie_draft_id IS NULL
  ORDER BY pick.id FOR UPDATE;
  FOR v_reference IN
    SELECT constraint_row.conrelid::regclass AS relation,
      string_agg(format('referenced.%I = pick.%I',child.attname,parent.attname),' AND ' ORDER BY keys.ordinality) AS condition
    FROM pg_catalog.pg_constraint constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey,constraint_row.confkey) WITH ORDINALITY AS keys(child_number,parent_number,ordinality)
    JOIN pg_catalog.pg_attribute child ON child.attrelid=constraint_row.conrelid AND child.attnum=keys.child_number
    JOIN pg_catalog.pg_attribute parent ON parent.attrelid=constraint_row.confrelid AND parent.attnum=keys.parent_number
    WHERE constraint_row.contype='f' AND constraint_row.confrelid='public.draft_picks'::regclass
    GROUP BY constraint_row.oid,constraint_row.conrelid ORDER BY constraint_row.conrelid,constraint_row.oid
  LOOP
    v_predicate := v_predicate || format(' AND NOT EXISTS (SELECT 1 FROM %s AS referenced WHERE %s)',v_reference.relation,v_reference.condition);
  END LOOP;
  EXECUTE 'DELETE FROM public.draft_picks pick WHERE pick.league_id=$1 AND pick.season_year>$2
    AND pick.current_owner_id=pick.original_owner_id AND NOT pick.is_used AND pick.used_at IS NULL AND pick.rookie_draft_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.league_activity activity WHERE activity.league_id=pick.league_id
      AND activity.metadata->>''pick_id''=pick.id::text)' || v_predicate
    USING p_league_id,v_year+v_years;
END;
$$;

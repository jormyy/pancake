DO $$
DECLARE
  v_reference record;
  v_predicate text := '';
BEGIN
  LOCK TABLE public.draft_picks, public.league_activity IN SHARE ROW EXCLUSIVE MODE;

  FOR v_reference IN
    SELECT constraint_row.conrelid::regclass AS relation,
      string_agg(format('referenced.%I = pick.%I', child.attname, parent.attname), ' AND ' ORDER BY keys.ordinality) AS condition
    FROM pg_constraint constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey) WITH ORDINALITY AS keys(child_number, parent_number, ordinality)
    JOIN pg_attribute child ON child.attrelid=constraint_row.conrelid AND child.attnum=keys.child_number
    JOIN pg_attribute parent ON parent.attrelid=constraint_row.confrelid AND parent.attnum=keys.parent_number
    WHERE constraint_row.contype='f' AND constraint_row.confrelid='public.draft_picks'::regclass
    GROUP BY constraint_row.oid, constraint_row.conrelid
    ORDER BY constraint_row.conrelid, constraint_row.oid
  LOOP
    EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', v_reference.relation);
    v_predicate := v_predicate || format(' AND NOT EXISTS (SELECT 1 FROM %s AS referenced WHERE %s)',
      v_reference.relation, v_reference.condition);
  END LOOP;

  EXECUTE 'DELETE FROM public.draft_picks AS pick
    USING public.league_seasons AS season
    WHERE season.league_id=pick.league_id AND season.is_current
      AND pick.season_year>season.season_year+3
      AND NOT pick.is_used AND pick.used_at IS NULL AND pick.rookie_draft_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.league_activity activity
        WHERE activity.league_id=pick.league_id AND activity.metadata->>''pick_id''=pick.id::text)' || v_predicate;
END;
$$;

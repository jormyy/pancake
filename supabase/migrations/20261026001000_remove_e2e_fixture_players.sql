DO $$
DECLARE
  v_player_id uuid;
  v_reference_guards text;
BEGIN
  SELECT COALESCE(string_agg(format(
    ' AND NOT EXISTS (SELECT 1 FROM %s AS reference WHERE %s)',
    foreign_key.conrelid::regclass,
    (SELECT string_agg(format('reference.%I = player.%I', source.attname, target.attname), ' AND ' ORDER BY columns.ordinality)
     FROM unnest(foreign_key.conkey, foreign_key.confkey) WITH ORDINALITY AS columns(source_number, target_number, ordinality)
     JOIN pg_attribute source ON source.attrelid = foreign_key.conrelid AND source.attnum = columns.source_number
     JOIN pg_attribute target ON target.attrelid = foreign_key.confrelid AND target.attnum = columns.target_number)
  ), ''), '') INTO v_reference_guards
  FROM pg_constraint foreign_key
  WHERE foreign_key.contype = 'f'
    AND foreign_key.confrelid = 'public.players'::regclass
    AND foreign_key.confdeltype IN ('a', 'r');

  FOR v_player_id IN
    SELECT id FROM public.players
    WHERE first_name = 'E2E'
      AND last_name ~ '^Player[0-9]{3}$'
      AND sleeper_id ~ '^e2e-sleeper-[0-9]{3}$'
      AND nba_id ~ '^E2ENBA[0-9]{3}$'
      AND sportsdata_id ~ '^e2e-player-[0-9]{3}$'
    FOR UPDATE
  LOOP
    BEGIN
      EXECUTE 'DELETE FROM public.players AS player WHERE player.id = $1' || v_reference_guards
      USING v_player_id;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END LOOP;
END;
$$;

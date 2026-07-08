-- Ensure shared league state changes are delivered through Supabase Realtime.
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'leagues',
    'league_members',
    'league_seasons',
    'roster_players',
    'roster_transactions',
    'waiver_claims',
    'waiver_priorities',
    'waiver_wire_log',
    'draft_picks',
    'snake_draft_picks',
    'draft_room_members',
    'trades',
    'trade_items',
    'trade_participants',
    'trade_vetoes',
    'trade_block_items',
    'weekly_lineups'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', v_table);

      IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END IF;
  END LOOP;
END;
$$;

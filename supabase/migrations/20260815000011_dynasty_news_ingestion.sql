-- Dynasty Hub news was an empty shell: the read path existed but nothing ever
-- wrote dynasty_news. sync-players now ingests ESPN's keyless NBA news feed
-- (athletes mapped through players.espn_id). This migration adds the upsert
-- key and a 60-day retention window.

ALTER TABLE public.dynasty_news
  ADD CONSTRAINT dynasty_news_url_key UNIQUE (url);

CREATE OR REPLACE FUNCTION public.prune_unbounded_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sync_runs bigint;
  v_projection_runs bigint;
  v_weekly_lineups bigint;
  v_standings bigint;
  v_roster_transactions bigint;
  v_dynasty_news bigint;
BEGIN
  DELETE FROM public.sync_runs
   WHERE started_at < now() - interval '90 days';
  GET DIAGNOSTICS v_sync_runs = ROW_COUNT;

  -- fantasypros_projection_rows cascades from its run (ON DELETE CASCADE);
  -- product queries only read the latest run per date.
  DELETE FROM public.projection_sync_runs
   WHERE started_at < now() - interval '30 days';
  GET DIAGNOSTICS v_projection_runs = ROW_COUNT;

  -- Per-league season recency: rn 1 = current/most recent season.
  CREATE TEMP TABLE IF NOT EXISTS pruning_season_ranks ON COMMIT DROP AS
  SELECT
    id,
    league_id,
    row_number() OVER (PARTITION BY league_id ORDER BY season_year DESC) AS rn
  FROM public.league_seasons;

  -- Lineups are only read for the current matchup views; keep two seasons.
  DELETE FROM public.weekly_lineups AS wl
   USING pruning_season_ranks AS ranked
   WHERE wl.league_season_id = ranked.id
     AND ranked.rn > 2;
  GET DIAGNOSTICS v_weekly_lineups = ROW_COUNT;

  -- Old seasons keep each member's final standings snapshot (history and
  -- champion views read it); intermediate weekly snapshots are never shown.
  DELETE FROM public.standings AS s
   USING pruning_season_ranks AS ranked
   WHERE s.league_season_id = ranked.id
     AND ranked.rn > 2
     AND s.week_number < (
       SELECT max(inner_s.week_number)
         FROM public.standings AS inner_s
        WHERE inner_s.league_season_id = s.league_season_id
          AND inner_s.member_id = s.member_id
     );
  GET DIAGNOSTICS v_standings = ROW_COUNT;

  -- News feed shows a bounded recent list; keep 60 days.
  DELETE FROM public.dynasty_news
   WHERE published_at < now() - interval '60 days';
  GET DIAGNOSTICS v_dynasty_news = ROW_COUNT;

  -- Transaction history UI pages recent activity; keep three seasons.
  DELETE FROM public.roster_transactions AS rt
   USING pruning_season_ranks AS ranked
   WHERE rt.league_season_id = ranked.id
     AND ranked.rn > 3;
  GET DIAGNOSTICS v_roster_transactions = ROW_COUNT;

  DROP TABLE IF EXISTS pruning_season_ranks;

  RETURN jsonb_build_object(
    'sync_runs', v_sync_runs,
    'projection_sync_runs', v_projection_runs,
    'weekly_lineups', v_weekly_lineups,
    'standings', v_standings,
    'roster_transactions', v_roster_transactions,
    'dynasty_news', v_dynasty_news
  );
END;
$$;

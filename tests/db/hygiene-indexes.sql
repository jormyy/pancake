BEGIN;
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('idx_projections_player_week','player_projections_player_id_season_year_week_number_key'),
    ('idx_players_sportsdata_id','players_sportsdata_id_key'),
    ('idx_profiles_username','profiles_username_key'),
    ('idx_leagues_invite_code','leagues_invite_code_key'),
    ('idx_weekly_add_counts_member_week','weekly_add_counts_league_id_league_season_id_member_id_week_key')
  ) AS indexes(removed,retained) LOOP
    IF to_regclass('public.'||target.removed) IS NOT NULL THEN
      RAISE EXCEPTION 'Duplicate index % remains',target.removed;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.'||target.retained)
      AND indisunique AND indisvalid AND indisready) THEN
      RAISE EXCEPTION 'Retained unique index % is unavailable',target.retained;
    END IF;
  END LOOP;
END $$;
ROLLBACK;

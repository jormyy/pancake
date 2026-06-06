ALTER TABLE public.nba_games
  ADD COLUMN IF NOT EXISTS bbref_home_team text,
  ADD COLUMN IF NOT EXISTS bbref_away_team text;

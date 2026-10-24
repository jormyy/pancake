SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE public.sleeper_projection_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  source_game_id text NOT NULL,
  sleeper_id text NOT NULL,
  season_year integer NOT NULL,
  week_number integer NOT NULL,
  game_date date NOT NULL,
  team text NOT NULL,
  opponent text NOT NULL,
  points numeric NOT NULL CHECK (points >= 0),
  rebounds numeric NOT NULL CHECK (rebounds >= 0),
  assists numeric NOT NULL CHECK (assists >= 0),
  steals numeric NOT NULL CHECK (steals >= 0),
  blocks numeric NOT NULL CHECK (blocks >= 0),
  three_pointers_made numeric NOT NULL CHECK (three_pointers_made >= 0),
  turnovers numeric NOT NULL CHECK (turnovers >= 0),
  field_goals_made numeric NOT NULL CHECK (field_goals_made >= 0),
  field_goals_attempted numeric NOT NULL CHECK (field_goals_attempted >= 0),
  free_throws_made numeric NOT NULL CHECK (free_throws_made >= 0),
  free_throws_attempted numeric NOT NULL CHECK (free_throws_attempted >= 0),
  three_pointers_attempted numeric NOT NULL CHECK (three_pointers_attempted >= 0),
  minutes numeric NOT NULL CHECK (minutes >= 0),
  double_doubles numeric CHECK (double_doubles >= 0),
  triple_doubles numeric CHECK (triple_doubles >= 0),
  last_modified bigint NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, source_game_id),
  CHECK (field_goals_made <= field_goals_attempted AND free_throws_made <= free_throws_attempted
    AND three_pointers_made <= three_pointers_attempted)
);
CREATE INDEX sleeper_projection_rows_date ON public.sleeper_projection_rows(game_date, id);
CREATE INDEX sleeper_projection_rows_week ON public.sleeper_projection_rows(season_year, week_number, player_id, game_date);
CREATE INDEX fantasypros_projection_rows_run ON public.fantasypros_projection_rows(run_id, id);
CREATE INDEX projection_sync_runs_daily_success ON public.projection_sync_runs(source, projection_type, projection_date, started_at DESC, id DESC)
  WHERE status = 'success' AND completed_at IS NOT NULL;
CREATE INDEX projection_sync_runs_week_success ON public.projection_sync_runs(source, projection_type, season_year, week_number, started_at DESC, id DESC)
  WHERE status = 'success' AND completed_at IS NOT NULL;
ALTER TABLE public.sleeper_projection_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sleeper_projection_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sleeper_projection_rows TO authenticated;
GRANT ALL ON public.sleeper_projection_rows TO service_role;
CREATE POLICY sleeper_projection_rows_read ON public.sleeper_projection_rows FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.complete_sleeper_projection_sync(
  p_run_id uuid, p_rows jsonb, p_row_count integer, p_unmatched_count integer,
  p_http_status integer, p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_run public.projection_sync_runs%ROWTYPE; v_count integer;
BEGIN
  SELECT * INTO STRICT v_run FROM public.projection_sync_runs WHERE id=p_run_id FOR UPDATE;
  IF v_run.source <> 'sleeper' OR v_run.status <> 'running' OR jsonb_typeof(p_rows) <> 'array'
    OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 10000
    OR p_row_count <> jsonb_array_length(p_rows) + p_unmatched_count OR p_unmatched_count < 0
    OR p_http_status NOT BETWEEN 200 AND 299 THEN
    RAISE EXCEPTION 'Invalid Sleeper completion';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::public.sleeper_projection_rows,p_rows) r
    WHERE r.season_year IS DISTINCT FROM v_run.season_year OR r.week_number IS DISTINCT FROM v_run.week_number) THEN
    RAISE EXCEPTION 'Sleeper rows do not match their run';
  END IF;
  INSERT INTO public.sleeper_projection_rows AS stored (player_id, source_game_id, sleeper_id, season_year, week_number, game_date, team, opponent, points, rebounds, assists, steals, blocks, three_pointers_made, turnovers, field_goals_made, field_goals_attempted, free_throws_made, free_throws_attempted, three_pointers_attempted, minutes, double_doubles, triple_doubles, last_modified)
  SELECT player_id, source_game_id, sleeper_id, season_year, week_number, game_date, team, opponent, points, rebounds, assists, steals, blocks, three_pointers_made, turnovers, field_goals_made, field_goals_attempted, free_throws_made, free_throws_attempted, three_pointers_attempted, minutes, double_doubles, triple_doubles, last_modified FROM jsonb_populate_recordset(NULL::public.sleeper_projection_rows,p_rows)
  ON CONFLICT (player_id, source_game_id) DO UPDATE SET
    sleeper_id = EXCLUDED.sleeper_id,
    season_year = EXCLUDED.season_year,
    week_number = EXCLUDED.week_number,
    game_date = EXCLUDED.game_date,
    team = EXCLUDED.team,
    opponent = EXCLUDED.opponent,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    three_pointers_made = EXCLUDED.three_pointers_made,
    turnovers = EXCLUDED.turnovers,
    field_goals_made = EXCLUDED.field_goals_made,
    field_goals_attempted = EXCLUDED.field_goals_attempted,
    free_throws_made = EXCLUDED.free_throws_made,
    free_throws_attempted = EXCLUDED.free_throws_attempted,
    three_pointers_attempted = EXCLUDED.three_pointers_attempted,
    minutes = EXCLUDED.minutes,
    double_doubles = EXCLUDED.double_doubles,
    triple_doubles = EXCLUDED.triple_doubles,
    last_modified = EXCLUDED.last_modified,
    fetched_at = now()
  WHERE EXCLUDED.last_modified >= stored.last_modified;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.projection_sync_runs SET status='success', completed_at=now(), row_count=p_row_count,
    matched_count=jsonb_array_length(p_rows), unmatched_count=p_unmatched_count, http_status=p_http_status,
    source_metadata=p_metadata WHERE id=p_run_id;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_sleeper_projection_sync(uuid,jsonb,integer,integer,integer,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_sleeper_projection_sync(uuid,jsonb,integer,integer,integer,jsonb) TO service_role;

ALTER TABLE public.projection_sync_runs ADD COLUMN projection_period_end date NOT NULL DEFAULT CURRENT_DATE;
CREATE OR REPLACE FUNCTION private.set_projection_period_end()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.projection_date IS NOT NULL THEN
    NEW.projection_period_end:=NEW.projection_date;
  ELSE
    SELECT date_trunc('week',week_start::timestamp)::date+6 INTO NEW.projection_period_end
      FROM public.season_weeks WHERE season_year=NEW.season_year AND week_number=NEW.week_number;
    NEW.projection_period_end:=COALESCE(NEW.projection_period_end,(NEW.started_at AT TIME ZONE 'America/Los_Angeles')::date);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_projection_period_end() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER set_projection_period_end BEFORE INSERT OR UPDATE OF season_year,week_number,projection_date,started_at
  ON public.projection_sync_runs FOR EACH ROW EXECUTE FUNCTION private.set_projection_period_end();
ALTER TABLE public.projection_sync_runs DISABLE TRIGGER compact_resource_update;
UPDATE public.projection_sync_runs SET projection_date=projection_date;
ALTER TABLE public.projection_sync_runs ENABLE TRIGGER compact_resource_update;
CREATE INDEX projection_sync_runs_retention_period ON public.projection_sync_runs(projection_period_end,id);

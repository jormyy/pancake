BEGIN;
CREATE TABLE private.lineup_history_receipts(
  lineup_id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  game_date date NOT NULL,
  row_data jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lineup_history_receipts_player_date ON private.lineup_history_receipts(player_id,game_date);
ALTER TABLE private.lineup_history_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.lineup_history_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.lineup_game_started(p_player_id uuid, p_game_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- A lineup slot locks once the player's game that day has started: the feed
  -- says so, its scheduled tip-off has passed, or a start time is recorded.
  WITH participation AS (
    SELECT game_id FROM player_game_stats WHERE player_id = p_player_id
    UNION
    SELECT game_id FROM private.player_game_memberships WHERE player_id = p_player_id
  )
  SELECT EXISTS (SELECT 1 FROM private.lineup_history_receipts r
    WHERE r.player_id=p_player_id AND r.game_date=p_game_date) OR EXISTS (
    SELECT 1
      FROM players AS p
      JOIN nba_games AS g
        ON g.game_date = p_game_date
       AND (
         ((g.home_team = p.nba_team OR g.away_team = p.nba_team)
           AND NOT EXISTS (
             SELECT 1 FROM participation AS observed
             JOIN nba_games AS actual ON actual.id = observed.game_id
             WHERE actual.game_date = p_game_date
           ))
         OR EXISTS (
           SELECT 1 FROM participation AS stats
            WHERE stats.game_id = g.id
         )
       )
     WHERE p.id = p_player_id
       AND (
         g.status IN ('InProgress', 'Final')
         OR (g.game_time IS NOT NULL AND g.game_time <= now())
         OR (g.started_at IS NOT NULL AND g.started_at <= now())
       )
  )
$$;

CREATE OR REPLACE FUNCTION private.history_capture_lineup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'players' THEN
    INSERT INTO private.lineup_history_receipts(lineup_id,player_id,game_date,row_data)
    SELECT w.id,w.player_id,w.game_date,to_jsonb(w)
    FROM public.weekly_lineups w
    WHERE w.player_id=OLD.id
      AND (w.game_date < (now() AT TIME ZONE 'America/New_York')::date
        OR private.lineup_game_started(w.player_id,w.game_date))
    ON CONFLICT(lineup_id) DO NOTHING;
    RETURN NEW;
  END IF;
  IF OLD.game_date < (now() AT TIME ZONE 'America/New_York')::date
    OR private.lineup_game_started(OLD.player_id,OLD.game_date) THEN
    INSERT INTO private.lineup_history_receipts(lineup_id,player_id,game_date,row_data)
    VALUES(OLD.id,OLD.player_id,OLD.game_date,to_jsonb(OLD))
    ON CONFLICT(lineup_id) DO NOTHING;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION private.history_restore_lineups()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE restored integer;
BEGIN
  WITH recovered AS (
    INSERT INTO public.weekly_lineups
    SELECT (jsonb_populate_record(NULL::public.weekly_lineups,r.row_data)).*
    FROM private.lineup_history_receipts r
    JOIN public.league_seasons s ON s.id=(r.row_data->>'league_season_id')::uuid
    JOIN public.league_members m ON m.id=(r.row_data->>'member_id')::uuid AND m.league_id=s.league_id
    JOIN public.players p ON p.id=r.player_id
    WHERE NOT EXISTS(SELECT 1 FROM private.retired_score_inputs retired WHERE retired.league_season_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM public.weekly_lineups w WHERE w.id=r.lineup_id)
    ORDER BY r.lineup_id
    ON CONFLICT DO NOTHING
    RETURNING *
  )
  INSERT INTO public.league_events(league_id,member_id,kind,summary,detail)
  SELECT league_id,member_id,'lineup.history_restored','Historical lineup restored',
    jsonb_build_object('lineup_id',id,'player_id',player_id,'game_date',game_date,'row',to_jsonb(recovered))
  FROM recovered;
  GET DIAGNOSTICS restored=ROW_COUNT;
  RAISE LOG 'Historical lineup repair restored % rows',restored;
  RETURN restored;
END;
$$;

REVOKE ALL ON FUNCTION private.history_capture_lineup(),private.history_restore_lineups() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.history_restore_lineups() TO service_role;
CREATE TRIGGER history_capture_player_lineups BEFORE UPDATE OF nba_team ON public.players
FOR EACH ROW WHEN (OLD.nba_team IS DISTINCT FROM NEW.nba_team) EXECUTE FUNCTION private.history_capture_lineup();
CREATE TRIGGER history_capture_lineup BEFORE UPDATE OR DELETE ON public.weekly_lineups
FOR EACH ROW EXECUTE FUNCTION private.history_capture_lineup();
INSERT INTO private.lineup_history_receipts(lineup_id,player_id,game_date,row_data)
SELECT w.id,w.player_id,w.game_date,to_jsonb(w) FROM public.weekly_lineups w
WHERE w.game_date < (now() AT TIME ZONE 'America/New_York')::date OR private.lineup_game_started(w.player_id,w.game_date)
ON CONFLICT DO NOTHING;
COMMIT;

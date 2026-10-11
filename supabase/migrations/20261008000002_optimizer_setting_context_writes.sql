-- Keep owner and service writes within the same league/member/season tuple.
-- Refuse inconsistent legacy rows; this migration never repairs or deletes them.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.league_members, public.league_seasons,
  public.lineup_optimizer_settings IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.lineup_optimizer_settings AS settings
    LEFT JOIN public.league_members AS member ON member.id = settings.member_id
    LEFT JOIN public.league_seasons AS season ON season.id = settings.league_season_id
    WHERE member.league_id IS DISTINCT FROM settings.league_id
       OR season.league_id IS DISTINCT FROM settings.league_id
  ) THEN
    RAISE EXCEPTION 'Optimizer settings contain inconsistent league/member/season tuples; reconcile separately before applying this migration';
  END IF;
END;
$$;

ALTER TABLE public.league_members
  ADD CONSTRAINT league_members_id_league_key UNIQUE (id, league_id);
ALTER TABLE public.league_seasons
  ADD CONSTRAINT league_seasons_id_league_key UNIQUE (id, league_id);

ALTER TABLE public.lineup_optimizer_settings
  ADD CONSTRAINT lineup_optimizer_settings_member_league_fkey
    FOREIGN KEY (member_id, league_id)
    REFERENCES public.league_members (id, league_id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT lineup_optimizer_settings_season_league_fkey
    FOREIGN KEY (league_season_id, league_id)
    REFERENCES public.league_seasons (id, league_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.lineup_optimizer_settings
  VALIDATE CONSTRAINT lineup_optimizer_settings_member_league_fkey,
  VALIDATE CONSTRAINT lineup_optimizer_settings_season_league_fkey;

-- PostgREST upsert updates all supplied columns, including its conflict key.
-- Existing owner RLS remains in force; audit fields and DELETE stay unavailable.
GRANT INSERT (league_id, league_season_id, member_id, enabled, enabled_at),
  UPDATE (league_id, league_season_id, member_id, enabled, enabled_at)
  ON public.lineup_optimizer_settings TO authenticated;

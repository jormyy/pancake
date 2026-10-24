BEGIN;
ALTER TABLE public.league_members DROP CONSTRAINT IF EXISTS league_members_team_name_valid;
ALTER TABLE public.league_members ALTER COLUMN team_name DROP DEFAULT;
CREATE TEMP TABLE legacy_names AS
SELECT gen_random_uuid() AS user_id,gen_random_uuid() AS member_id,source,expected
FROM (VALUES
  (NULL::text,'My Team'),
  ('','My Team'),
  (E' \t\n ','My Team'),
  (repeat('a',41),repeat('a',40)),
  (repeat('界',41),repeat('界',40)),
  ('  Keep Me  ','Keep Me'),
  ('Valid Name','Valid Name')
) AS names(source,expected);
SELECT gen_random_uuid() AS league_id \gset
INSERT INTO auth.users(id,email,raw_user_meta_data)
SELECT user_id,user_id||'@example.test','{}' FROM legacy_names;
INSERT INTO public.leagues(id,name,slug,commissioner_id)
SELECT :'league_id','Legacy team names',:'league_id',user_id FROM legacy_names LIMIT 1;
INSERT INTO public.league_members(id,league_id,user_id,team_name)
SELECT member_id,:'league_id',user_id,source FROM legacy_names;
\ir ../../supabase/migrations/20261026000060_team_name_validation.sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM legacy_names fixture JOIN public.league_members member ON member.id=fixture.member_id
    WHERE member.team_name IS DISTINCT FROM fixture.expected) THEN
    RAISE EXCEPTION 'Legacy team names do not normalize safely';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.league_members'::regclass
    AND conname='league_members_team_name_valid' AND convalidated) THEN
    RAISE EXCEPTION 'Legacy team names retain an unvalidated constraint';
  END IF;
END $$;
ROLLBACK;

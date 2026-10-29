\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.players(nba_id,espn_id,first_name,last_name)
VALUES('1629726','3913180','Garrison','Mathews'),('1628998','3138161','Cody','Martin'),
  ('1630649','4279532','Stanley','Umude'),('1628420','3059310','Monte','Morris'),
  ('1630548','4432817','Johnny','Juzang'),('1641816','4395620','Hunter','Tyson')
ON CONFLICT(nba_id) DO NOTHING;
DO $$
DECLARE reviewed record; result jsonb; before_count bigint; after_count bigint;
BEGIN
  FOR reviewed IN SELECT * FROM (VALUES
    ('3913180','1629726','Garrison','Mathews'),
    ('3138161','1628998','Cody','Martin'),
    ('4279532','1630649','Stanley','Umude'),
    ('3059310','1628420','Monte','Morris'),
    ('4432817','1630548','Johnny','Juzang'),
    ('4395620','1641816','Hunter','Tyson')
  ) links(espn_id,nba_id,first_name,last_name) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.players WHERE nba_id=reviewed.nba_id AND espn_id=reviewed.espn_id) THEN
      RAISE EXCEPTION 'Reviewed identity is not linked: %',reviewed.nba_id;
    END IF;
    SELECT count(*) INTO before_count FROM public.players;
    result:=public.resolve_player_imports_atomic('espn',jsonb_build_array(jsonb_build_object(
      'provider_id',reviewed.espn_id,'first_name',reviewed.first_name,'last_name',reviewed.last_name,'metadata','{}'::jsonb)));
    SELECT count(*) INTO after_count FROM public.players;
    IF result->'results'->0->>'action'='ambiguous' OR before_count<>after_count THEN
      RAISE EXCEPTION 'Reviewed identity remains ambiguous or creates a duplicate: %',reviewed.nba_id;
    END IF;
  END LOOP;
END;
$$;
ROLLBACK;
SELECT 'six reviewed provider links pass';

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$
DECLARE link record; owner public.players%ROWTYPE;
BEGIN
  FOR link IN SELECT * FROM (VALUES
    ('3913180','1629726','Garrison Mathews'),
    ('3138161','1628998','Cody Martin'),
    ('4279532','1630649','Stanley Umude'),
    ('3059310','1628420','Monte Morris'),
    ('4432817','1630548','Johnny Juzang'),
    ('4395620','1641816','Hunter Tyson')
  ) reviewed(espn_id,nba_id,display_name) LOOP
    SELECT * INTO owner FROM public.players WHERE nba_id=link.nba_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF private.player_identity_name(owner.display_name) IS DISTINCT FROM private.player_identity_name(link.display_name)
      OR (owner.espn_id IS NOT NULL AND owner.espn_id<>link.espn_id)
      OR EXISTS(SELECT 1 FROM public.players p WHERE p.espn_id=link.espn_id AND p.id<>owner.id) THEN
      RAISE EXCEPTION 'Reviewed provider link conflicts for NBA identity %',link.nba_id;
    END IF;
    UPDATE public.players SET espn_id=link.espn_id WHERE id=owner.id AND espn_id IS NULL;
  END LOOP;
END;
$$;
COMMIT;

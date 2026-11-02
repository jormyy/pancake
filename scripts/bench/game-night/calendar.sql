DO $$
DECLARE zone text; instant timestamptz;
BEGIN
  SELECT timezone INTO STRICT zone FROM public.leagues WHERE id=game_night.id(1);
  FOREACH instant IN ARRAY ARRAY['2026-01-15T05:30:00Z'::timestamptz,'2026-07-15T04:30:00Z'::timestamptz] LOOP
    IF (instant AT TIME ZONE zone)::date<>(instant AT TIME ZONE 'America/New_York')::date THEN
      RAISE EXCEPTION 'The fixture league and feed use different calendar dates near Eastern midnight';
    END IF;
  END LOOP;
END;
$$;

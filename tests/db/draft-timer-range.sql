BEGIN;
DO $$
DECLARE
  v_message text;
BEGIN
  FOREACH v_message IN ARRAY ARRAY['59','604801'] LOOP
    BEGIN
      PERFORM public.start_rookie_draft_atomic(gen_random_uuid(), 3, false, v_message::int);
      RAISE EXCEPTION 'Invalid rookie timer accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%between 60 and 604800%' THEN RAISE; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.start_rookie_draft_atomic(gen_random_uuid(), 3, false, 604800);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'League not found' THEN RAISE; END IF;
  END;
END;
$$;
ROLLBACK;

CREATE FUNCTION pg_temp.drain_forecast_chunks() RETURNS void LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
  FOR step IN 1..1000 LOOP
    result:=public.run_scheduler_chunk('forecasts');
    IF NOT (result->>'remaining')::boolean THEN RETURN; END IF;
  END LOOP;
  RAISE EXCEPTION 'Forecast chunks did not drain';
END;
$$;
CREATE FUNCTION pg_temp.drain_notification_chunks(p_now timestamptz DEFAULT now()) RETURNS void LANGUAGE plpgsql AS $$
DECLARE result jsonb; was_paused boolean;
BEGIN
  SELECT paused INTO was_paused FROM private.worker_controls WHERE id;
  UPDATE private.worker_controls SET paused=true WHERE id;
  FOR step IN 1..1000 LOOP
    result:=public.run_scheduler_chunk('notifications',false,p_now);
    IF NOT (result->>'remaining')::boolean THEN
      UPDATE private.worker_controls SET paused=was_paused WHERE id;
      RETURN;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Notification chunks did not drain';
END;
$$;

CREATE FUNCTION pg_temp.scan_notifications(p_now timestamptz DEFAULT now()) RETURNS void LANGUAGE plpgsql AS $$
DECLARE result jsonb; was_paused boolean;
BEGIN
  SELECT paused INTO was_paused FROM private.worker_controls WHERE id;
  UPDATE private.worker_controls SET paused=true WHERE id;
  UPDATE private.notification_scan_state SET available_at=p_now,scan_at=NULL,after_member_id=NULL WHERE id;
  PERFORM public.notif_scan_due_atomic(p_now);
  LOOP
    result:=private.complete_notification_scan_chunk(p_now);
    EXIT WHEN NOT (result->>'remaining')::boolean;
  END LOOP;
  UPDATE private.worker_controls SET paused=was_paused WHERE id;
END;
$$;

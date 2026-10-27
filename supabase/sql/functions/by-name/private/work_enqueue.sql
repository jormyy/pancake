CREATE OR REPLACE FUNCTION private.work_enqueue(p_kind text, p_key text, p_due_at timestamptz DEFAULT now(), p_payload jsonb DEFAULT '{}'::jsonb, p_league_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
  VALUES(p_kind,p_key,p_due_at,p_payload,p_league_id)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

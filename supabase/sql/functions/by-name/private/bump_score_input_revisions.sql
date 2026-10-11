CREATE OR REPLACE FUNCTION private.bump_score_input_revisions(p_keys text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_key text;
BEGIN
  FOR v_key IN SELECT DISTINCT value FROM unnest(p_keys) value WHERE value IS NOT NULL ORDER BY value LOOP
    INSERT INTO private.score_input_revisions(scope, revision) VALUES(v_key, 1)
      ON CONFLICT(scope) DO UPDATE SET revision = score_input_revisions.revision + 1;
  END LOOP;
END;
$$;

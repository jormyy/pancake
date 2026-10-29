GRANT EXECUTE ON FUNCTION private.player_identity_name(text) TO service_role;
DO $$
BEGIN
  IF NOT has_function_privilege('service_role','private.player_identity_name(text)','EXECUTE')
    OR has_function_privilege('anon','private.player_identity_name(text)','EXECUTE')
    OR has_function_privilege('authenticated','private.player_identity_name(text)','EXECUTE') THEN
    RAISE EXCEPTION 'Identity index execution grants differ from the internal write contract';
  END IF;
END;
$$;

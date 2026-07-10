DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS index_class
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_class.relnamespace
      JOIN pg_catalog.pg_index AS index_state
        ON index_state.indexrelid = index_class.oid
     WHERE index_namespace.nspname = 'public'
       AND index_class.relname = 'profiles_push_token_lookup'
       AND (NOT index_state.indisvalid OR NOT index_state.indisready)
  ) THEN
    ALTER INDEX public.profiles_push_token_lookup
      RENAME TO profiles_push_token_lookup_invalid;
  END IF;
END;
$$;

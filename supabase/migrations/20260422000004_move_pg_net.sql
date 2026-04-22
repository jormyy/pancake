-- ============================================================
-- Migration: Move pg_net out of public schema (drop + recreate)
--
-- pg_net does not support ALTER EXTENSION ... SET SCHEMA, so we
-- must drop and recreate it in the extensions schema.
--
-- The extension creates a dedicated "net" schema with its
-- functions (net.http_post, etc.). Those objects are recreated
-- automatically when the extension is created again.
--
-- DEFENSIVE CHECKS:
--   1. Abort if net.http_post is missing before we start.
--   2. Abort if net.http_post is missing after recreation.
--   3. Re-create invoke_edge_function if it was cascade-dropped.
-- ============================================================

DO $$
DECLARE
  _has_http_post  boolean;
  _invoke_src     text;
BEGIN
  -- ── 1. Pre-flight check ────────────────────────────────────
  SELECT EXISTS(
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'net' AND p.proname = 'http_post'
  ) INTO _has_http_post;

  IF NOT _has_http_post THEN
    RAISE EXCEPTION '[pg_net move] net.http_post missing before migration. Aborting.';
  END IF;

  -- ── 2. Save invoke_edge_function source (defensive) ────────
  SELECT pg_get_functiondef(p.oid)
    INTO _invoke_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'invoke_edge_function';

  -- ── 3. Drop and recreate pg_net in extensions ─────────────
  DROP EXTENSION IF EXISTS pg_net;
  CREATE EXTENSION pg_net WITH SCHEMA extensions;

  -- ── 4. Post-flight check ───────────────────────────────────
  SELECT EXISTS(
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'net' AND p.proname = 'http_post'
  ) INTO _has_http_post;

  IF NOT _has_http_post THEN
    RAISE EXCEPTION '[pg_net move] net.http_post missing after recreation. Migration failed.';
  END IF;

  -- ── 5. Restore invoke_edge_function if it vanished ─────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'invoke_edge_function'
  ) AND _invoke_src IS NOT NULL THEN
    EXECUTE _invoke_src;
  END IF;

END $$;

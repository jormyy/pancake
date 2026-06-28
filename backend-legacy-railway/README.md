# Legacy Railway/Fastify Backend

This directory is a non-runtime rollback reference for the backend that used to
run on Railway.

- Runtime API traffic now goes through Supabase Edge Function `api`.
- Background work now runs through Supabase Cron, Edge Functions, and Postgres
  RPCs.
- This package is intentionally not listed in the root npm workspaces.
- Deletion criteria: remove this directory after the Supabase-only backend has
  passed the production validation window and no rollback reference is needed.

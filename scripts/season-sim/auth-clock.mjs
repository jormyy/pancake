export const accessTokenHookSql = `
CREATE SCHEMA IF NOT EXISTS perf_lab;
CREATE OR REPLACE FUNCTION perf_lab.replay_claims(event jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_set(event,'{claims,iat}',to_jsonb(least((event->'claims'->>'iat')::bigint,floor(extract(epoch FROM season_sim.time()))::bigint)))
$$;
REVOKE ALL ON FUNCTION perf_lab.replay_claims(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA perf_lab TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION perf_lab.replay_claims(jsonb) TO supabase_auth_admin;
`

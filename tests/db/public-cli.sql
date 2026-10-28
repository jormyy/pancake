BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL session_replication_role = replica;
DO $$
DECLARE
  league uuid;
  owner_id uuid;
  team uuid;
  token text;
  replacement text;
  result jsonb;
  resource text;
  season uuid;
  player uuid;
  snake uuid := gen_random_uuid();
  auction uuid := gen_random_uuid();
  nomination uuid := gen_random_uuid();
BEGIN
  SELECT member.league_id, member.user_id, member.id INTO league, owner_id, team
    FROM public.league_members member JOIN public.leagues l ON l.id = member.league_id AND l.deleted_at IS NULL
    WHERE member.role = 'commissioner' ORDER BY member.league_id LIMIT 1;
  IF league IS NULL THEN RAISE EXCEPTION 'Restore the backup before this check.'; END IF;
  SELECT id INTO season FROM public.league_seasons WHERE league_id = league AND is_current;
  SELECT id INTO player FROM public.players ORDER BY id LIMIT 1;
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,started_at,completed_at,rounds)
    VALUES (snake,league,season,'snake','completed',false,now(),now(),1),
      (auction,league,season,'auction','completed',false,now(),now(),1);
  INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,player_id,picked_at)
    VALUES (snake,1,1,1,team,player,now());
  INSERT INTO public.nominations(id,draft_id,player_id,nominating_member_id,status,winning_member_id,final_price,nomination_order)
    VALUES (nomination,auction,player,team,'sold',team,5,1);
  IF has_table_privilege('anon', 'public.league_share_tokens', 'SELECT')
    OR has_table_privilege('authenticated', 'public.league_share_tokens', 'SELECT')
    OR has_table_privilege('anon', 'public.public_read_log', 'SELECT')
    OR has_function_privilege('anon', 'public.public_read(text,text,jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.public_read(text,text,jsonb)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.public_share_token(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Public credentials or privileged reads are exposed.';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
  BEGIN
    PERFORM public.public_share_token(league, 'rotate');
    RAISE EXCEPTION 'Unauthorized token management succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  token := public.public_share_token(league, 'rotate')->>'token';
  IF length(token) <> 64 OR EXISTS (SELECT 1 FROM public.league_share_tokens WHERE token_hash = token) THEN
    RAISE EXCEPTION 'Raw token storage or invalid entropy.';
  END IF;
  IF (public.public_read(repeat('0',64), 'league')->>'status')::integer <> 401 THEN
    RAISE EXCEPTION 'An invalid token was accepted.';
  END IF;
  FOR resource IN SELECT unnest(ARRAY['league','standings','rosters','matchups','scores','schedule','transactions','draft-results','player-stats','projections']) LOOP
    result := public.public_read(token, resource, jsonb_build_object('targetMemberId', team, 'limit', 5));
    IF (result->>'status')::integer <> 200 THEN RAISE EXCEPTION 'Resource % failed: %', resource, result->>'status'; END IF;
    IF current_setting('request.jwt.claim.sub') <> owner_id::text THEN RAISE EXCEPTION 'Reader identity escaped the function.'; END IF;
    IF result::text ~ '"(user_id|userId|email|claims|assignments|faabBalance|activeBids|pendingClaimIds|privateNotes)"' THEN
      RAISE EXCEPTION 'Private field escaped the database projection for %.', resource;
    END IF;
  END LOOP;
  result := public.public_read(token, 'draft-results', '{"limit":50}');
  IF NOT (result->'items' @> jsonb_build_array(jsonb_build_object('draftId', snake, 'draftType', 'snake', 'overallPick', 1)))
    OR NOT (result->'items' @> jsonb_build_array(jsonb_build_object('draftId', auction, 'draftType', 'auction', 'price', 5))) THEN
    RAISE EXCEPTION 'Settled draft results are missing.';
  END IF;
  result := public.public_read(token, 'player-stats', jsonb_build_object('seasonYear', 2025, 'limit', 5));
  IF (result->>'status')::integer <> 200 THEN RAISE EXCEPTION 'Player history incorrectly requires a league season.'; END IF;
  UPDATE public.league_share_tokens SET window_reads = 59 WHERE league_id = league;
  IF (public.public_read(token, 'league')->>'status')::integer <> 200 THEN RAISE EXCEPTION 'The final allowed read failed.'; END IF;
  IF (public.public_read(token, 'league')->>'status')::integer <> 429 THEN RAISE EXCEPTION 'The rate limit did not reject excess reads.'; END IF;
  UPDATE public.league_share_tokens SET window_started_at = now() - interval '2 minutes' WHERE league_id = league;
  IF (public.public_read(token, 'league')->>'status')::integer <> 200 THEN RAISE EXCEPTION 'The rate limit did not reset.'; END IF;
  replacement := public.public_share_token(league, 'rotate')->>'token';
  IF (public.public_read(token, 'league')->>'status')::integer <> 401 THEN RAISE EXCEPTION 'Rotation retained the old token.'; END IF;
  IF (public.public_read(replacement, 'league')->>'status')::integer <> 200 THEN RAISE EXCEPTION 'Rotation did not enable the new token.'; END IF;
  INSERT INTO public.public_read_log(league_id, hour, resource, reads) VALUES (league, now() - interval '8 days', 'league', 1);
  PERFORM public.public_prune_read_log();
  IF EXISTS (SELECT 1 FROM public.public_read_log WHERE league_id = league AND hour < now() - interval '8 days' + interval '1 second') THEN
    RAISE EXCEPTION 'Expired audit rows survive retention.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.public_read_log WHERE league_id = league AND reads > 0 AND rejected > 0) THEN
    RAISE EXCEPTION 'Public reads and rate rejections were not audited.';
  END IF;
  PERFORM public.public_share_token(league, 'revoke');
  IF (public.public_read(replacement, 'league')->>'status')::integer <> 401 THEN RAISE EXCEPTION 'A revoked token was accepted.'; END IF;
END;
$$;
ROLLBACK;

-- Real authenticated and anonymous controls for draft-context drops.
-- Synthetic fixtures, helper functions, and all changes roll back.
BEGIN;

CREATE FUNCTION pg_temp.must(p_ok boolean,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Control failed: %',p_label USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.call_as(p_role text,p_user uuid,p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',p_user::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user,'role',p_role)::text,true);
  EXECUTE format('SET LOCAL ROLE %I',p_role);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  RETURN v_state;
END;
$$;

CREATE FUNCTION pg_temp.drop_state(p_leagues uuid[])
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'roster',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY id)
      FROM public.roster_players r WHERE league_id=ANY(p_leagues)),'[]'::jsonb),
    'waivers',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY id)
      FROM public.waiver_wire_log w WHERE league_id=ANY(p_leagues)),'[]'::jsonb),
    'transactions',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id)
      FROM public.roster_transactions t WHERE league_id=ANY(p_leagues)),'[]'::jsonb)
  );
$$;

DO $$
DECLARE
  v_user uuid:=gen_random_uuid();
  v_other_user uuid:=gen_random_uuid();
  v_league uuid:=gen_random_uuid();
  v_other_league uuid:=gen_random_uuid();
  v_member uuid:=gen_random_uuid();
  v_other_member uuid:=gen_random_uuid();
  v_season uuid:=gen_random_uuid();
  v_old_season uuid:=gen_random_uuid();
  v_other_season uuid:=gen_random_uuid();
  v_draft uuid:=gen_random_uuid();
  v_old_draft uuid:=gen_random_uuid();
  v_foreign_draft uuid:=gen_random_uuid();
  v_players uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
    gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_rows uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
    gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_old_row uuid:=gen_random_uuid();
  v_before jsonb;
  v_after_first jsonb;
  v_code text;
  v_case text;
  v_sql text;
  v_index int;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now()),
        (v_other_user,'authenticated','authenticated',v_other_user||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,taxi_slots)
  VALUES(v_league,'Draft Drop Control',v_league::text,v_user,'drafting',2,2),
        (v_other_league,'Foreign Draft Control',v_other_league::text,v_user,'drafting',2,2);
  INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
  VALUES(v_member,v_league,v_user,'commissioner','Control Owner'),
        (v_other_member,v_league,v_other_user,'manager','Other Owner');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
  VALUES(v_old_season,v_league,3988,false),(v_season,v_league,3989,true),
        (v_other_season,v_other_league,3989,true);
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(v_draft,v_league,v_season,'snake','completed',false,1),
        (v_old_draft,v_league,v_old_season,'snake','completed',false,1),
        (v_foreign_draft,v_other_league,v_other_season,'snake','completed',false,1);
  FOR v_index IN 1..6 LOOP
    INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions,
      years_exp,nba_draft_number,injury_status)
    VALUES(v_players[v_index],'Drop',v_players[v_index]::text,'XDP','PG',ARRAY['PG'],0,1,'Out');
  END LOOP;
  FOR v_index IN 1..3 LOOP
    INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(v_rows[v_index],v_league,v_season,v_member,v_players[v_index],'draft');
  END LOOP;
  INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir)
  VALUES(v_rows[4],v_league,v_season,v_other_member,v_players[4],'draft',false),
        (v_rows[5],v_league,v_season,v_member,v_players[5],'draft',true);
  PERFORM private.authorize_taxi_acquisition(v_league,v_season,v_member,v_players[6],'draft',v_draft);
  INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi)
  VALUES(v_rows[6],v_league,v_season,v_member,v_players[6],'draft',true);
  INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(v_old_row,v_league,v_old_season,v_member,v_players[1],'draft');
  PERFORM pg_temp.must((SELECT count(*)=3 FROM public.roster_players
    WHERE member_id=v_member AND league_season_id=v_season AND NOT is_on_ir AND NOT is_on_taxi),
    'fixture is exactly one active player over capacity');

  -- Context and inactive-target denials run while a genuine active overflow exists.
  FOREACH v_case IN ARRAY ARRAY['wrong_owner','wrong_expected_season','historical_row',
    'old_draft','wrong_league','missing_expected_season','mock','cancelled','pending',
    'auction','ir_target','taxi_target','missing_draft'] LOOP
    UPDATE public.drafts SET is_mock=false,draft_type='snake',status='completed' WHERE id=v_draft;
    v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',
      v_rows[1],v_season,v_draft);
    CASE v_case
      WHEN 'wrong_owner' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[4],v_season,v_draft);
      WHEN 'wrong_expected_season' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[1],v_old_season,v_draft);
      WHEN 'historical_row' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_old_row,v_old_season,v_old_draft);
      WHEN 'old_draft' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[1],v_season,v_old_draft);
      WHEN 'wrong_league' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[1],v_season,v_foreign_draft);
      WHEN 'missing_expected_season' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,NULL::uuid,%L::uuid)',v_rows[1],v_draft);
      WHEN 'mock' THEN UPDATE public.drafts SET is_mock=true WHERE id=v_draft;
      WHEN 'cancelled' THEN UPDATE public.drafts SET status='cancelled' WHERE id=v_draft;
      WHEN 'pending' THEN UPDATE public.drafts SET status='pending' WHERE id=v_draft;
      WHEN 'auction' THEN UPDATE public.drafts SET draft_type='auction' WHERE id=v_draft;
      WHEN 'ir_target' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[5],v_season,v_draft);
      WHEN 'taxi_target' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[6],v_season,v_draft);
      WHEN 'missing_draft' THEN v_sql:=format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[1],v_season,gen_random_uuid());
    END CASE;
    v_before:=pg_temp.drop_state(ARRAY[v_league,v_other_league]);
    v_code:=pg_temp.call_as('authenticated',v_user,v_sql);
    PERFORM pg_temp.must(v_code IN ('P0001','P0002'),v_case||' rejects through a business guard, not an ACL or missing-function error');
    PERFORM pg_temp.must(pg_temp.drop_state(ARRAY[v_league,v_other_league])=v_before,
      v_case||' preserves exact roster, waiver, and transaction state');
  END LOOP;
  UPDATE public.drafts SET is_mock=false,draft_type='snake',status='completed' WHERE id=v_draft;

  -- Anonymous calls must fail at the actual RPC permission boundary.
  v_before:=pg_temp.drop_state(ARRAY[v_league,v_other_league]);
  FOR v_index IN 1..3 LOOP
    v_sql:=CASE v_index
      WHEN 1 THEN format('SELECT public.drop_player_atomic(%L::uuid)',v_rows[1])
      WHEN 2 THEN format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid)',v_rows[1],v_season)
      ELSE format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[1],v_season,v_draft)
    END;
    v_code:=pg_temp.call_as('anon',v_user,v_sql);
    PERFORM pg_temp.must(v_code='42501','anon cannot call drop overload '||v_index);
    PERFORM pg_temp.must(pg_temp.drop_state(ARRAY[v_league,v_other_league])=v_before,
      'anonymous rejection leaves all drop state unchanged');
  END LOOP;

  -- Every permitted draft phase gets a real successful authenticated mutation.
  -- The deliberate exception rolls back each positive mutation to its baseline.
  FOREACH v_case IN ARRAY ARRAY['in_progress','paused','completed'] LOOP
    BEGIN
      UPDATE public.drafts SET status=v_case::draft_status WHERE id=v_draft;
      v_code:=pg_temp.call_as('authenticated',v_user,
        format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[1],v_season,v_draft));
      PERFORM pg_temp.must(v_code IS NULL,v_case||' accepts an owned active overflow drop');
      PERFORM pg_temp.must(NOT EXISTS(SELECT 1 FROM public.roster_players WHERE id=v_rows[1]),
        v_case||' actually removes the target');
      PERFORM pg_temp.must((SELECT count(*)=1 FROM public.waiver_wire_log
        WHERE league_id=v_league AND player_id=v_players[1]) AND
        (SELECT count(*)=1 FROM public.roster_transactions WHERE league_id=v_league
          AND player_id=v_players[1] AND transaction_type='fa_drop'),
        v_case||' records one waiver and one drop transaction');
      RAISE EXCEPTION 'Rollback successful phase control' USING ERRCODE='ZX001';
    EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
    END;
  END LOOP;

  -- Lost-reply sequence: ignore the first successful response, then choose another row.
  v_code:=pg_temp.call_as('authenticated',v_user,
    format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[1],v_season,v_draft));
  PERFORM pg_temp.must(v_code IS NULL,'first completed-room drop succeeds');
  PERFORM pg_temp.must((SELECT count(*)=2 FROM public.roster_players WHERE
    league_season_id=v_season AND member_id=v_member AND NOT is_on_ir AND NOT is_on_taxi),
    'first response leaves the authoritative roster exactly at capacity');
  v_after_first:=pg_temp.drop_state(ARRAY[v_league,v_other_league]);
  v_code:=pg_temp.call_as('authenticated',v_user,
    format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[2],v_season,v_draft));
  PERFORM pg_temp.must(v_code='P0001','second different target rejects after overflow is resolved');
  PERFORM pg_temp.must(pg_temp.drop_state(ARRAY[v_league,v_other_league])=v_after_first,
    'second different drop preserves the exact first-drop roster and logs');
  v_code:=pg_temp.call_as('authenticated',v_user,
    format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid,%L::uuid)',v_rows[1],v_season,v_draft));
  PERFORM pg_temp.must(v_code='P0002','same-target retry rejects the missing row');
  PERFORM pg_temp.must(pg_temp.drop_state(ARRAY[v_league,v_other_league])=v_after_first,
    'same-target retry cannot create another waiver or transaction');

  -- Ordinary two-argument drop remains valid at capacity, without draft intent.
  v_code:=pg_temp.call_as('authenticated',v_user,
    format('SELECT public.drop_player_atomic(%L::uuid,%L::uuid)',v_rows[2],v_season));
  PERFORM pg_temp.must(v_code IS NULL AND NOT EXISTS(SELECT 1 FROM public.roster_players WHERE id=v_rows[2]),
    'ordinary season-bound drop remains allowed at capacity');
  -- Ordinary one-argument drop remains valid below capacity.
  v_code:=pg_temp.call_as('authenticated',v_user,
    format('SELECT public.drop_player_atomic(%L::uuid)',v_rows[3]));
  PERFORM pg_temp.must(v_code IS NULL AND NOT EXISTS(SELECT 1 FROM public.roster_players WHERE id=v_rows[3]),
    'ordinary legacy drop remains allowed below capacity');
  PERFORM pg_temp.must((SELECT count(*)=3 FROM public.waiver_wire_log WHERE league_id=v_league)
    AND (SELECT count(*)=3 FROM public.roster_transactions WHERE league_id=v_league AND transaction_type='fa_drop'),
    'only the three successful drops create history');
  PERFORM pg_temp.must(EXISTS(SELECT 1 FROM public.roster_players WHERE id=v_old_row)
    AND EXISTS(SELECT 1 FROM public.roster_players WHERE id=v_rows[4])
    AND EXISTS(SELECT 1 FROM public.roster_players WHERE id=v_rows[5])
    AND EXISTS(SELECT 1 FROM public.roster_players WHERE id=v_rows[6]),
    'history, foreign ownership, IR, and taxi rows survive these controls');

  RAISE NOTICE 'Draft-context drop controls reach all assertions; fixtures roll back.';
END;
$$;
ROLLBACK;

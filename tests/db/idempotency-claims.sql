\ir idempotency-support.sql
DO $$
DECLARE f record; claim uuid; other uuid; player uuid;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  SELECT id INTO player FROM idempotency_players WHERE n=1;
  claim := (pg_temp.retry('claim create', f.user_ids[1], format('public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L,12)', f.league_id,f.member_ids[1],player,f.user_ids[1]), 'public.create_waiver_claim_atomic')#>>'{}')::uuid;
  PERFORM pg_temp.retry('claim edit', f.user_ids[1], format('public.edit_waiver_claim_atomic(%L,%L,%L,NULL,15)', claim,f.member_ids[1],f.user_ids[1]), 'public.edit_waiver_claim_atomic');
  SELECT id INTO player FROM idempotency_players WHERE n=2;
  other := (pg_temp.retry('claim create second', f.user_ids[1], format('public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L,1)', f.league_id,f.member_ids[1],player,f.user_ids[1]), 'public.create_waiver_claim_atomic')#>>'{}')::uuid;
  PERFORM pg_temp.retry('claim reorder', f.user_ids[1], format('public.reorder_waiver_claim_atomic(%L,%L,%L,%L)',other,f.member_ids[1],f.user_ids[1],'up'), 'public.reorder_waiver_claim_atomic');
  PERFORM pg_temp.retry('claim cancel', f.user_ids[1], format('public.cancel_waiver_claim_atomic(%L,%L,%L)',claim,f.member_ids[1],f.user_ids[1]), 'public.cancel_waiver_claim_atomic');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM waiver_claims WHERE league_id=f.league_id), 'claim creation applies once');
END;
$$;
\ir idempotency-cleanup.sql

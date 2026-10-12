BEGIN;
CREATE TEMP TABLE own_push_users AS SELECT gen_random_uuid() a, gen_random_uuid() b, gen_random_uuid() c;
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
FROM own_push_users, LATERAL unnest(ARRAY[a,b,c]) id;
SELECT set_config('test.push.a',a::text,true),set_config('test.push.b',b::text,true),set_config('test.push.c',c::text,true) FROM own_push_users;
SELECT set_config('test.push.endpoint','https://fcm.googleapis.com/fcm/send/owned-'||gen_random_uuid(),true);

SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM public.register_web_push_atomic(current_setting('test.push.a')::uuid,current_setting('test.push.endpoint'),repeat('A',87),repeat('A',22),0,repeat('a',64),repeat('b',64));
  RAISE EXCEPTION 'Anonymous registration succeeded';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM public.register_web_push_atomic(current_setting('test.push.a')::uuid,current_setting('test.push.endpoint'),repeat('A',87),repeat('A',22),0,repeat('a',64),repeat('b',64));
  RAISE EXCEPTION 'Authenticated direct registration succeeded';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM public.clear_web_push_for_user_atomic(current_setting('test.push.a')::uuid,current_setting('test.push.endpoint'),repeat('b',64));
  RAISE EXCEPTION 'Authenticated direct cleanup succeeded';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM * FROM private.web_push_controls;
  RAISE EXCEPTION 'Service role read credential controls directly';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$
DECLARE a uuid:=current_setting('test.push.a'); b uuid:=current_setting('test.push.b'); e text:=current_setting('test.push.endpoint'); r record;
BEGIN
  SELECT * INTO r FROM public.register_web_push_atomic(a,e,repeat('A',87),repeat('A',22),0,repeat('a',64),repeat('b',64));
  IF NOT r.applied OR r.generation<>1 THEN RAISE EXCEPTION 'Initial registration failed'; END IF;
  SELECT * INTO r FROM public.register_web_push_atomic(b,e,repeat('A',87),repeat('A',22),0,repeat('a',64),repeat('c',64));
  IF r.applied OR r.generation IS NOT NULL THEN RAISE EXCEPTION 'Initial replay reset existing authority'; END IF;
  SELECT * INTO r FROM public.register_web_push_atomic(b,e,repeat('A',87),repeat('A',22),1,repeat('a',64),repeat('c',64));
  IF r.applied THEN RAISE EXCEPTION 'Wrong credential transferred ownership'; END IF;
  SELECT * INTO r FROM public.register_web_push_atomic(b,e,repeat('A',87),repeat('A',22),1,repeat('b',64),repeat('c',64));
  IF NOT r.applied OR r.generation<>2 THEN RAISE EXCEPTION 'Current device authority did not transfer to B'; END IF;
  SELECT * INTO r FROM public.clear_web_push_for_user_atomic(a,e,repeat('d',64));
  IF r.applied OR r.generation IS NOT NULL THEN RAISE EXCEPTION 'Old A cleanup cleared B'; END IF;
  SELECT * INTO r FROM public.clear_web_push_for_user_atomic(b,e,repeat('d',64));
  IF NOT r.applied OR r.generation<>3 THEN RAISE EXCEPTION 'B cleanup did not rotate authority'; END IF;
  SELECT * INTO r FROM public.register_web_push_atomic(a,e,repeat('A',87),repeat('A',22),1,repeat('b',64),repeat('e',64));
  IF r.applied THEN RAISE EXCEPTION 'Delayed A registration restored A'; END IF;
  SELECT * INTO r FROM public.register_web_push_atomic(b,e,repeat('A',87),repeat('A',22),3,repeat('d',64),repeat('e',64));
  IF NOT r.applied OR r.generation<>4 THEN RAISE EXCEPTION 'Registration after cleanup failed'; END IF;
  DELETE FROM public.web_push_subscriptions WHERE endpoint=e;
  SELECT * INTO r FROM public.register_web_push_atomic(a,e,repeat('A',87),repeat('A',22),0,repeat('a',64),repeat('f',64));
  IF r.applied THEN RAISE EXCEPTION 'Pruning reset ownership authority'; END IF;
  SELECT * INTO r FROM public.register_web_push_atomic(b,e,repeat('A',87),repeat('A',22),4,repeat('e',64),repeat('f',64));
  IF NOT r.applied OR r.generation<>5 THEN RAISE EXCEPTION 'Current authority could not restore pruned delivery'; END IF;
END $$;
RESET ROLE;
DELETE FROM public.profiles WHERE id=current_setting('test.push.b')::uuid;
DO $$ DECLARE c record; BEGIN
 SELECT * INTO STRICT c FROM private.web_push_controls WHERE endpoint=current_setting('test.push.endpoint');
 IF c.generation<>6 OR c.owner_id IS NOT NULL OR c.credential_hash IS NOT NULL THEN RAISE EXCEPTION 'Deletion did not retain revoked tombstone'; END IF;
 IF EXISTS(SELECT 1 FROM public.web_push_subscriptions WHERE endpoint=c.endpoint) THEN RAISE EXCEPTION 'Deleted profile retained delivery'; END IF;
END $$;
SET LOCAL ROLE service_role;
DO $$ DECLARE r record; BEGIN
 SELECT * INTO r FROM public.register_web_push_atomic(current_setting('test.push.a')::uuid,current_setting('test.push.endpoint'),repeat('A',87),repeat('A',22),5,repeat('f',64),repeat('a',64));
 IF r.applied THEN RAISE EXCEPTION 'Pre-deletion credential was reused'; END IF;
 SELECT * INTO r FROM public.register_web_push_atomic(current_setting('test.push.a')::uuid,current_setting('test.push.endpoint'),repeat('A',87),repeat('A',22),6,repeat('f',64),repeat('a',64));
 IF r.applied THEN RAISE EXCEPTION 'Null revocation hash recovered implicitly'; END IF;
END $$;
DO $$
DECLARE a uuid:=current_setting('test.push.a'); c uuid:=current_setting('test.push.c'); e text:=current_setting('test.push.endpoint')||'-legacy'; r record;
BEGIN
 INSERT INTO public.web_push_subscriptions(user_id,endpoint,p256dh,auth) VALUES(a,e,repeat('A',87),repeat('A',22));
 SELECT * INTO r FROM public.register_web_push_atomic(c,e,repeat('A',87),repeat('A',22),0,repeat('a',64),repeat('b',64));
 IF r.applied THEN RAISE EXCEPTION 'Other account bootstrapped legacy owner'; END IF;
 SELECT * INTO r FROM public.register_web_push_atomic(a,e,repeat('A',87),repeat('A',22),0,repeat('a',64),repeat('b',64));
 IF NOT r.applied OR r.generation<>1 THEN RAISE EXCEPTION 'Legacy same-owner enrollment failed'; END IF;
 SELECT * INTO r FROM public.register_web_push_atomic(a,e,repeat('A',87),repeat('A',22),1,repeat('b',64),repeat('c',64));
 IF NOT r.applied OR r.generation<>2 THEN RAISE EXCEPTION 'Same-owner rotation failed'; END IF;
 SELECT * INTO r FROM public.clear_web_push_for_user_atomic(a,e,repeat('d',64));
 IF NOT r.applied OR r.generation<>3 THEN RAISE EXCEPTION 'Owner cleanup failed after unacknowledged rotation'; END IF;
 SELECT * INTO r FROM public.clear_web_push_for_user_atomic(a,e||'-absent',repeat('b',64));
 IF NOT r.applied OR r.generation<>1 THEN RAISE EXCEPTION 'Absent-row cleanup failed'; END IF;
 SELECT * INTO r FROM public.register_web_push_atomic(a,e||'-absent',repeat('A',87),repeat('A',22),0,repeat('a',64),repeat('c',64));
 IF r.applied THEN RAISE EXCEPTION 'Delayed first registration passed tombstone'; END IF;
END $$;
RESET ROLE;
ROLLBACK;

BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; pick uuid; year integer; inputs jsonb; corrected jsonb; quote jsonb; offer uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9566);
  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(f.league_id,9567,1,f.member_ids[1],f.member_ids[1]) RETURNING id,season_year INTO pick,year;
  inputs:=public.get_trade_estimate_inputs(f.user_ids[1],f.member_ids[1],jsonb_build_array(
    jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2],'pickId',pick)));
  UPDATE public.draft_picks SET season_year=year-1 WHERE id=pick;
  PERFORM pg_temp.reject_rules(format('SELECT public.save_trade_estimate_quote(%L,%L,%L,%L,%L)',
    f.user_ids[1],f.member_ids[1],inputs,'{"teams":[],"assets":[]}','fence-fixture'),
    'Draft pick years changed. Refresh the trade estimate and try again.',
    'an estimate read before the repair cannot save stale pick years afterward');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.trade_estimate_quotes WHERE league_id=f.league_id),
    'rejected delayed writer leaves no partial quote');
  corrected:=jsonb_set(inputs,'{picks,0,seasonYear}',to_jsonb(year-1));
  quote:=public.save_trade_estimate_quote(f.user_ids[1],f.member_ids[1],corrected,'{"teams":[],"assets":[]}','fence-fixture');
  PERFORM pg_temp.check_rules(quote->>'id'=public.save_trade_estimate_quote(f.user_ids[1],f.member_ids[1],corrected,
    '{"teams":[],"assets":[]}','fence-fixture')->>'id','a refreshed estimate saves and deduplicates normally');
  PERFORM pg_temp.reject_rules(format('UPDATE public.trade_estimate_quotes SET inputs=%L WHERE id=%L',inputs,quote->>'id'),
    'Draft pick years changed. Refresh the trade estimate and try again.','direct quote updates cannot restore stale years');
  offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',jsonb_build_object(
    'leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
    'offerFaabAmount',1,'requestFaabAmount',1));
  PERFORM pg_temp.reject_rules(format('INSERT INTO public.trade_estimate_history(trade_id,formula_version,snapshot) VALUES(%L,%L,%L)',
    offer,'stale',jsonb_build_object('inputs',inputs)),
    'Draft pick years changed. Refresh the trade estimate and try again.','history inserts reject delayed root pick inputs');
  INSERT INTO public.trade_estimate_history(trade_id,formula_version,snapshot)
    VALUES(offer,'current',jsonb_build_object('inputs',corrected,'quote',jsonb_build_object('inputs',corrected)));
  PERFORM pg_temp.reject_rules(format('UPDATE public.trade_estimate_history SET snapshot=%L WHERE trade_id=%L AND formula_version=%L',
    jsonb_build_object('inputs',corrected,'quote',jsonb_build_object('inputs',inputs)),offer,'current'),
    'Draft pick years changed. Refresh the trade estimate and try again.','history updates reject delayed nested quote inputs');
  PERFORM pg_temp.check_rules((SELECT snapshot->'quote'->'inputs'=corrected FROM public.trade_estimate_history
    WHERE trade_id=offer AND formula_version='current'),'rejected history writer preserves the corrected snapshot');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

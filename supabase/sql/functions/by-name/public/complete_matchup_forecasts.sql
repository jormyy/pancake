CREATE OR REPLACE FUNCTION public.complete_matchup_forecasts(p_results jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; saved boolean; results jsonb:='[]';
BEGIN
  IF jsonb_typeof(p_results) IS DISTINCT FROM 'array' OR jsonb_array_length(p_results)>25 THEN
    RAISE EXCEPTION 'A bounded forecast result array is required.' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(DISTINCT value->>'matchupId') FROM jsonb_array_elements(p_results))<>jsonb_array_length(p_results) THEN
    RAISE EXCEPTION 'Forecast results require unique matchup identities.' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_results) LOOP
    BEGIN
      saved:=public.complete_matchup_forecast((item->>'matchupId')::uuid,(item->>'revision')::bigint,
        (item->>'claimToken')::uuid,item->'forecast',(item->>'validUntil')::timestamptz);
      results:=results||jsonb_build_array(jsonb_build_object('matchupId',item->>'matchupId','saved',saved));
    EXCEPTION WHEN OTHERS THEN
      results:=results||jsonb_build_array(jsonb_build_object('matchupId',item->>'matchupId','saved',false,'error',SQLERRM,'code',SQLSTATE));
    END;
  END LOOP;
  RETURN results;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_matchup_forecasts(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_matchup_forecasts(jsonb) TO service_role;

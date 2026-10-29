BEGIN;
DO $$
DECLARE league uuid; pick uuid; source text; payload jsonb; changed integer; bounds jsonb; value numeric;
BEGIN
  SELECT member.league_id,p.id INTO league,pick FROM public.draft_picks p
    JOIN public.league_members member ON member.id=p.original_owner_id LIMIT 1;
  IF pick IS NULL THEN RAISE EXCEPTION 'A production-shaped pick is required'; END IF;
  SELECT content_sha256 INTO source FROM private.trade_value_sync_state WHERE id;
  IF source IS NULL THEN RAISE EXCEPTION 'A retained source is required'; END IF;
  FOR bounds IN SELECT jsonb_array_elements('[{"early":465.55,"mid":320.35,"late":323.72},{"early":700,"mid":900,"late":300}]') LOOP
    payload:=jsonb_build_array(jsonb_build_object('id',pick,'odds',jsonb_build_object('early',0,'mid',1,'late',0),
      'bands',bounds,'value',bounds->'mid','details',jsonb_build_object('model','pick-finish-v1')));
    changed:=public.save_pick_predictions(league,payload,source);
    IF changed<>1 OR NOT EXISTS(SELECT 1 FROM public.draft_picks WHERE id=pick
      AND predicted_trade_value=(bounds->>'mid')::numeric AND predicted_value_bands=bounds) THEN
      RAISE EXCEPTION 'A valid middle-tier blend was changed or rejected';
    END IF;
    FOR value IN SELECT unnest(ARRAY[least((bounds->>'early')::numeric,(bounds->>'mid')::numeric,(bounds->>'late')::numeric)-1,
      greatest((bounds->>'early')::numeric,(bounds->>'mid')::numeric,(bounds->>'late')::numeric)+1]) LOOP
      BEGIN
        PERFORM public.save_pick_predictions(league,jsonb_set(payload,'{0,value}',to_jsonb(value)),source);
        RAISE EXCEPTION 'An out-of-range prediction was accepted';
      EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
      END;
    END LOOP;
    BEGIN
      PERFORM public.save_pick_predictions(league,jsonb_set(payload,'{0,odds,mid}','0.9'),source);
      RAISE EXCEPTION 'Invalid odds were accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
      PERFORM public.save_pick_predictions(league,jsonb_set(payload,'{0,value}','null'),source);
      RAISE EXCEPTION 'A nonnumeric prediction was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    IF public.save_pick_predictions(league,payload,source||'-stale')<>0 THEN RAISE EXCEPTION 'Stale source was accepted'; END IF;
  END LOOP;
END;
$$;
ROLLBACK;

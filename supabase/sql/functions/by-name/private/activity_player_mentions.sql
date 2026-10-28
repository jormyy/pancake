CREATE OR REPLACE FUNCTION private.activity_player_mentions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE mentions jsonb;
BEGIN
  WITH identities AS (
    SELECT NEW.related_player_id AS id
    UNION
    SELECT item.player_id FROM public.trade_items item
    JOIN public.trades trade ON trade.id=item.trade_id AND trade.league_id=NEW.league_id
    WHERE trade.id=NEW.related_trade_id AND NEW.event_type IN ('trade_offered','trade_countered','trade_edited','trade_accepted','trade_rejected','trade_withdrawn','trade_expired','trade_vetoed','trade_completed')
    UNION
    SELECT unnest(participant.drop_player_ids) FROM public.trade_participants participant
    JOIN public.trades trade ON trade.id=participant.trade_id AND trade.league_id=NEW.league_id
    WHERE trade.id=NEW.related_trade_id AND NEW.event_type='trade_completed'
    UNION
    SELECT unnest(ARRAY[claim.player_id,claim.drop_player_id]) FROM public.waiver_claims claim
    WHERE claim.id=NEW.related_claim_id AND claim.league_id=NEW.league_id
    UNION
    SELECT (entry->>'id')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.metadata->'player_mentions')='array' THEN NEW.metadata->'player_mentions' ELSE '[]'::jsonb END) entry
    WHERE entry->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',COALESCE(p.display_name,concat_ws(' ',p.first_name,p.last_name))) ORDER BY p.id),'[]') INTO mentions
  FROM identities JOIN public.players p ON p.id=identities.id;
  NEW.metadata:=COALESCE(NEW.metadata,'{}')||jsonb_build_object('player_mentions',mentions);
  RETURN NEW;
END;
$$;

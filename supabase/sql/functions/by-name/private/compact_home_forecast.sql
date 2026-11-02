CREATE OR REPLACE FUNCTION private.compact_home_forecast(p_forecast jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT CASE WHEN p_forecast IS NULL OR p_forecast='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('stale',p_forecast->'stale',
        'tieProbability',p_forecast->'tieProbability','missingInputs',COALESCE((
          SELECT jsonb_agg(value) FROM jsonb_array_elements_text(p_forecast->'missingInputs') value
          WHERE value LIKE 'Projection substituted:%'),'[]'::jsonb),
        'teams',COALESCE((SELECT jsonb_agg(jsonb_build_object('memberId',team->'memberId','projectedFinal',team->'projectedFinal',
          'currentPoints',team->'currentPoints','winProbability',team->'winProbability'))
          FROM jsonb_array_elements(p_forecast->'teams') team),'[]'::jsonb),
        'games',COALESCE((SELECT jsonb_agg(jsonb_build_object('gameId',game->'gameId','playerId',game->'playerId','memberId',game->'memberId'))
          FROM jsonb_array_elements(p_forecast->'games') game WHERE p_forecast->'missingInputs'
            @>jsonb_build_array('Projection substituted: '||(game->>'playerId')||':'||(game->>'gameId'))),'[]'::jsonb)) END;
$$;

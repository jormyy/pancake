CREATE TEMP TABLE source_trade_document(body jsonb);
\copy source_trade_document FROM PROGRAM 'node -e "require(process.argv[1]).writeFileSync(1,JSON.stringify(require(process.argv[2])))" node:fs ./tests/fixtures/trade-values/onenumberhoops.json' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
CREATE TEMP TABLE source_trade_values AS SELECT value AS row
  FROM source_trade_document CROSS JOIN LATERAL jsonb_array_elements(body->'data');
CREATE TEMP TABLE source_trade_players AS SELECT row,gen_random_uuid() AS player_id
  FROM source_trade_values WHERE row->>'pos'<>'PICK';
INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team)
  SELECT player_id,split_part(row->>'player',' ',1),substr(row->>'player',strpos(row->>'player',' ')+1),
    (row->'posArray'->>0)::public.nba_position,ARRAY(SELECT jsonb_array_elements_text(row->'posArray')),row->>'team'
  FROM source_trade_players;
UPDATE private.trade_value_sync_state SET fetched_at=NULL WHERE id;
SELECT public.publish_trade_values(
  (SELECT jsonb_agg(jsonb_build_object('source_id',row->>'id','name',row->>'player','team',row->>'team',
    'positions',row->'posArray','rank',(row->>'rank')::int,'value',(row->>'value')::numeric/10,
    'age',(row->>'age')::numeric,'player_id',CASE WHEN row->>'id'='alexcaruso' THEN NULL ELSE player_id END,
    'reason','fixture','candidate_ids',jsonb_build_array(player_id))) FROM source_trade_players),
  (SELECT jsonb_agg(jsonb_build_object('year',left(row->>'id',4)::int,
    'round',CASE WHEN row->>'id' LIKE '%1st%' THEN 1 ELSE 2 END,
    'tier',substring(row->>'id' FROM '(early|mid|late)'),'value',(row->>'value')::numeric/10))
    FROM source_trade_values WHERE row->>'pos'='PICK'),
  (SELECT body::text FROM source_trade_document),clock_timestamp(),'json');

BEGIN;
CREATE TEMP TABLE actions_value_document(body jsonb);
\copy actions_value_document FROM PROGRAM 'node -e "require(process.argv[1]).writeFileSync(1,JSON.stringify(require(process.argv[2])))" node:fs ./tests/fixtures/trade-values/onenumberhoops.json' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
CREATE TEMP TABLE actions_value_rows AS SELECT value row FROM actions_value_document CROSS JOIN LATERAL jsonb_array_elements(body->'data');
INSERT INTO private.trade_value_sync_state(id) VALUES(true) ON CONFLICT DO NOTHING;
SELECT public.publish_trade_values(
  (SELECT jsonb_agg(jsonb_build_object('source_id',row->>'id','name',row->>'player','team',row->>'team','positions',row->'posArray',
    'rank',(row->>'rank')::integer,'value',(row->>'value')::numeric/10,'age',(row->>'age')::numeric,
    'player_id',(SELECT id FROM public.players WHERE lower(regexp_replace(display_name,'[^a-zA-Z0-9]','','g'))=lower(regexp_replace(row->>'player','[^a-zA-Z0-9]','','g')) ORDER BY id LIMIT 1),
    'reason','local recorded catalog','candidate_ids','[]'::jsonb)) FROM actions_value_rows WHERE row->>'pos'<>'PICK'),
  (SELECT jsonb_agg(jsonb_build_object('year',left(row->>'id',4)::integer,'round',CASE WHEN row->>'id' LIKE '%1st%' THEN 1 ELSE 2 END,
    'tier',substring(row->>'id' FROM '(early|mid|late)'),'value',(row->>'value')::numeric/10)) FROM actions_value_rows WHERE row->>'pos'='PICK'),
  (SELECT body::text FROM actions_value_document),'2026-10-28T12:00:00Z','json');
COMMIT;
ANALYZE;

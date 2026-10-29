BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='500ms';
WITH RECURSIVE tree(root_id,index_id) AS (
  SELECT i.indexrelid,i.indexrelid FROM pg_index i
  UNION ALL
  SELECT tree.root_id,child.inhrelid FROM tree JOIN pg_inherits child ON child.inhparent=tree.index_id
), usage AS (
  SELECT tree.root_id,sum(coalesce(s.idx_scan,0)) AS scans,
    sum(pg_relation_size(tree.index_id)) AS bytes,count(*) AS physical_indexes
  FROM tree LEFT JOIN pg_stat_all_indexes s ON s.indexrelid=tree.index_id
  GROUP BY tree.root_id
), candidates AS (
  SELECT a.indexrelid AS candidate,b.indexrelid AS replacement,
    a.indrelid AS relation,a.indnkeyatts=b.indnkeyatts AND a.indnatts=b.indnatts AS same_width
  FROM pg_index a JOIN pg_index b ON a.indrelid=b.indrelid AND a.indexrelid<>b.indexrelid
  JOIN pg_class ac ON ac.oid=a.indexrelid JOIN pg_class bc ON bc.oid=b.indexrelid
  JOIN pg_class relation ON relation.oid=a.indrelid JOIN pg_namespace n ON n.oid=relation.relnamespace
  WHERE n.nspname IN ('public','private','analytics')
    AND NOT relation.relispartition AND ac.relam=bc.relam
    AND ac.relam=(SELECT oid FROM pg_am WHERE amname='btree')
    AND a.indisvalid AND b.indisvalid AND a.indisready AND b.indisready
    AND NOT a.indisunique AND NOT a.indisprimary AND NOT a.indisreplident
    AND NOT EXISTS(SELECT FROM pg_constraint WHERE conindid=a.indexrelid)
    AND a.indexprs IS NULL AND b.indexprs IS NULL
    AND pg_get_expr(a.indpred,a.indrelid) IS NOT DISTINCT FROM pg_get_expr(b.indpred,b.indrelid)
    AND a.indnkeyatts<=b.indnkeyatts
    AND ARRAY(SELECT value FROM unnest(a.indkey) WITH ORDINALITY key(value,position) WHERE position<=a.indnkeyatts ORDER BY position)
      =ARRAY(SELECT value FROM unnest(b.indkey) WITH ORDINALITY key(value,position) WHERE position<=a.indnkeyatts ORDER BY position)
    AND ARRAY(SELECT value FROM unnest(a.indclass) WITH ORDINALITY key(value,position) WHERE position<=a.indnkeyatts ORDER BY position)
      =ARRAY(SELECT value FROM unnest(b.indclass) WITH ORDINALITY key(value,position) WHERE position<=a.indnkeyatts ORDER BY position)
    AND ARRAY(SELECT value FROM unnest(a.indcollation) WITH ORDINALITY key(value,position) WHERE position<=a.indnkeyatts ORDER BY position)
      =ARRAY(SELECT value FROM unnest(b.indcollation) WITH ORDINALITY key(value,position) WHERE position<=a.indnkeyatts ORDER BY position)
    AND ARRAY(SELECT value FROM unnest(a.indoption) WITH ORDINALITY key(value,position) WHERE position<=a.indnkeyatts ORDER BY position)
      =ARRAY(SELECT value FROM unnest(b.indoption) WITH ORDINALITY key(value,position) WHERE position<=a.indnkeyatts ORDER BY position)
    AND a.indkey::smallint[] <@ b.indkey::smallint[]
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'relation',c.relation::regclass::text,'candidate',c.candidate::regclass::text,
  'replacement',c.replacement::regclass::text,'sameWidth',c.same_width,
  'candidateScansIncludingChildren',a.scans,'replacementScansIncludingChildren',b.scans,
  'candidateBytesIncludingChildren',a.bytes,'physicalIndexes',a.physical_indexes,
  'candidateDefinition',pg_get_indexdef(c.candidate),'replacementDefinition',pg_get_indexdef(c.replacement)
) ORDER BY a.bytes DESC,c.candidate,c.replacement),'[]'::jsonb)
FROM candidates c JOIN usage a ON a.root_id=c.candidate JOIN usage b ON b.root_id=c.replacement;
ROLLBACK;

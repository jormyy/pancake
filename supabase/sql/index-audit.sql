WITH usage AS (
  SELECT coalesce(pg_partition_root(stats.indexrelid),stats.indexrelid) AS index_id,
    sum(stats.idx_scan) AS scans,sum(stats.idx_tup_read) AS tuples_read,
    sum(pg_relation_size(stats.indexrelid)) AS bytes
  FROM pg_stat_user_indexes stats
  GROUP BY coalesce(pg_partition_root(stats.indexrelid),stats.indexrelid)
), candidates AS (
  SELECT source.indexrelid AS candidate,cover.indexrelid AS covering
  FROM pg_index source JOIN pg_class source_class ON source_class.oid=source.indexrelid
  JOIN pg_index cover ON cover.indrelid=source.indrelid AND cover.indexrelid<>source.indexrelid
  JOIN pg_class cover_class ON cover_class.oid=cover.indexrelid
  WHERE NOT source.indisunique AND source.indisvalid AND cover.indisvalid
    AND source_class.relam=cover_class.relam AND source.indexprs IS NULL AND cover.indexprs IS NULL
    AND source.indnkeyatts=source.indnatts AND source.indnkeyatts<=cover.indnkeyatts
    AND (source.indkey::smallint[])[0:source.indnkeyatts-1]=(cover.indkey::smallint[])[0:source.indnkeyatts-1]
    AND (source.indclass::oid[])[0:source.indnkeyatts-1]=(cover.indclass::oid[])[0:source.indnkeyatts-1]
    AND (source.indcollation::oid[])[0:source.indnkeyatts-1]=(cover.indcollation::oid[])[0:source.indnkeyatts-1]
    AND (source.indoption::smallint[])[0:source.indnkeyatts-1]=(cover.indoption::smallint[])[0:source.indnkeyatts-1]
    AND pg_get_expr(source.indpred,source.indrelid) IS NOT DISTINCT FROM pg_get_expr(cover.indpred,cover.indrelid)
)
SELECT usage.index_id::regclass AS index_name,indexes.indrelid::regclass AS table_name,
  usage.scans,usage.tuples_read,usage.bytes,indexes.indisunique AS unique_index,
  EXISTS(SELECT FROM pg_constraint constraint_row WHERE constraint_row.conindid=usage.index_id) AS constraint_index,
  (SELECT array_agg(candidate.covering::regclass::text ORDER BY candidate.covering::regclass::text)
    FROM candidates candidate WHERE candidate.candidate=usage.index_id) AS covering_indexes,
  pg_get_indexdef(usage.index_id) AS definition,
  (SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()) AS statistics_reset
FROM usage JOIN pg_index indexes ON indexes.indexrelid=usage.index_id
WHERE usage.scans=0 OR EXISTS(SELECT FROM candidates candidate WHERE candidate.candidate=usage.index_id)
ORDER BY usage.bytes DESC,index_name;

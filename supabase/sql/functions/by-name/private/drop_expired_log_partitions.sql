-- Canonical SQL source for private.drop_expired_log_partitions.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.drop_expired_log_partitions(p_parent regclass,p_cutoff timestamptz,p_now timestamptz DEFAULT now())
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE part record; removed bigint:=0; counted bigint; month_offset integer;
BEGIN
  PERFORM 1 FROM private.partitioned_log_policies policy JOIN pg_catalog.pg_class relation ON relation.oid=policy.parent_table AND relation.relkind='p' WHERE policy.parent_table=p_parent;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown partition retention parent'; END IF;
  FOR month_offset IN 0..2 LOOP
    PERFORM private.ensure_log_partition(p_parent,((p_now AT TIME ZONE 'UTC')::date+make_interval(months=>month_offset))::date);
  END LOOP;
  FOR part IN SELECT partition_table FROM private.log_partitions WHERE parent_table=p_parent
    AND upper_bound::timestamp AT TIME ZONE 'UTC'<=p_cutoff ORDER BY lower_bound LIMIT 12 LOOP
    EXECUTE format('SELECT count(*) FROM %s',part.partition_table) INTO counted;
    DELETE FROM private.retention_status WHERE relation_name=part.partition_table::text;
    DELETE FROM private.retention_rules WHERE relation_name=part.partition_table::text;
    EXECUTE format('DROP TABLE %s',part.partition_table);
    DELETE FROM private.log_partitions WHERE partition_table=part.partition_table;
    removed:=removed+counted;
  END LOOP;
  RETURN removed;
END;
$$;

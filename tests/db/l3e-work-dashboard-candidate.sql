CREATE INDEX work_items_dashboard ON private.work_items(kind) INCLUDE(status,due_at,lease_until) WHERE status<>'succeeded';

CREATE OR REPLACE FUNCTION public.work_dashboard()
RETURNS TABLE(kind text,due bigint,running bigint,failed bigint,dead bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT kinds.kind,
    count(*) FILTER(WHERE item.status IN ('pending','failed') AND item.due_at<=now()),
    count(*) FILTER(WHERE item.status='running' AND item.lease_until>now()),
    count(*) FILTER(WHERE item.status='failed' OR (item.status='running' AND item.lease_until<=now())),
    count(*) FILTER(WHERE item.status='dead')
  FROM private.work_kinds kinds LEFT JOIN private.work_items item ON item.kind=kinds.kind AND item.status<>'succeeded' GROUP BY kinds.kind ORDER BY kinds.kind;
$$;

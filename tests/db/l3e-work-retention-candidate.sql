CREATE INDEX work_items_retention ON private.work_items(status,completed_at,id) WHERE status IN ('succeeded','dead');

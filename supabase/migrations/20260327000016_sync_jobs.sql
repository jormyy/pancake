CREATE TABLE sync_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type        text NOT NULL,
    status          text NOT NULL DEFAULT 'pending',
    total_items     int,
    completed_items int NOT NULL DEFAULT 0,
    failed_items    int NOT NULL DEFAULT 0,
    error_log       jsonb DEFAULT '[]',
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    metadata        jsonb DEFAULT '{}'
);

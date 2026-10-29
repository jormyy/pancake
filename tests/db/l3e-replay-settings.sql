ALTER SYSTEM SET auto_explain.log_min_duration='25';
ALTER SYSTEM SET auto_explain.sample_rate='0.01';
SELECT pg_reload_conf();

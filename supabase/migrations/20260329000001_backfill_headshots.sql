-- Clear any bad Sleeper CDN URLs that were set previously
UPDATE players
SET headshot_url = NULL
WHERE headshot_url LIKE 'https://sleepercdn.com%';

-- Backfill headshot_url for players that have an nba_id using the NBA CDN
UPDATE players
SET headshot_url = 'https://cdn.nba.com/headshots/nba/latest/260x190/' || nba_id || '.png'
WHERE nba_id IS NOT NULL;

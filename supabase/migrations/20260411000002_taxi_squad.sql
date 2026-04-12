-- Add taxi squad support: a holding area for rookie draft picks that don't
-- fit the active roster. Taxi players don't count toward roster_size.
ALTER TABLE roster_players ADD COLUMN IF NOT EXISTS is_on_taxi boolean NOT NULL DEFAULT false;

-- Add taxi slot count to leagues (configurable per-league, default 2)
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS taxi_slots int NOT NULL DEFAULT 2;

-- Index for efficient taxi queries
CREATE INDEX IF NOT EXISTS idx_roster_players_taxi ON roster_players(member_id, league_season_id, is_on_taxi);

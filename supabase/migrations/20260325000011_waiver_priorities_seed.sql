-- Seed waiver_priorities for existing league members who don't have one yet.
-- Priority is assigned by join order (earliest = highest priority = 1).

INSERT INTO waiver_priorities (league_id, league_season_id, member_id, priority)
SELECT
    lm.league_id,
    ls.id AS league_season_id,
    lm.id AS member_id,
    ROW_NUMBER() OVER (
        PARTITION BY lm.league_id
        ORDER BY lm.joined_at
    ) AS priority
FROM league_members lm
JOIN league_seasons ls
    ON ls.league_id = lm.league_id
    AND ls.is_current = true
WHERE NOT EXISTS (
    SELECT 1 FROM waiver_priorities wp
    WHERE wp.member_id = lm.id
      AND wp.league_season_id = ls.id
);

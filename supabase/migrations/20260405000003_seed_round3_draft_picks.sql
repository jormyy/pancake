-- Add round 3 draft picks (matches ROOKIE_DRAFT_ROUNDS = 3 in backend config)
INSERT INTO draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
SELECT l.id, s.season_year, 3, lm.id, lm.id
FROM leagues l
CROSS JOIN (VALUES (2027), (2028), (2029)) AS s(season_year)
JOIN league_members lm ON lm.league_id = l.id
WHERE NOT EXISTS (
    SELECT 1 FROM draft_picks dp
    WHERE dp.league_id = l.id
      AND dp.season_year = s.season_year
      AND dp.round = 3
      AND dp.original_owner_id = lm.id
);

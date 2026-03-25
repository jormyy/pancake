INSERT INTO draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
SELECT l.id, s.season_year, s.round, lm.id, lm.id
FROM leagues l
CROSS JOIN (VALUES
    (2027, 1), (2027, 2),
    (2028, 1), (2028, 2),
    (2029, 1), (2029, 2)
) AS s(season_year, round)
JOIN league_members lm ON lm.league_id = l.id
WHERE NOT EXISTS (
    SELECT 1 FROM draft_picks dp
    WHERE dp.league_id = l.id AND dp.season_year = s.season_year AND dp.round = s.round AND dp.original_owner_id = lm.id
);

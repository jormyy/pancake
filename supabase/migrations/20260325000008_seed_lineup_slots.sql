-- Seed default lineup slot templates for any leagues that don't have them yet.
-- This covers leagues created before the trigger was in place.

INSERT INTO lineup_slot_templates (league_id, slot_type, slot_count)
SELECT l.id, s.slot_type::roster_slot_type, s.slot_count
FROM leagues l
CROSS JOIN (VALUES
    ('PG',    1),
    ('SG',    1),
    ('SF',    1),
    ('PF',    1),
    ('C',     1),
    ('G',     1),
    ('F',     1),
    ('UTIL',  3),
    ('BE',   10),
    ('IR',    2)
) AS s(slot_type, slot_count)
WHERE NOT EXISTS (
    SELECT 1 FROM lineup_slot_templates t WHERE t.league_id = l.id
);

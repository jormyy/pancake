ALTER TABLE leagues
    DROP CONSTRAINT IF EXISTS leagues_playoff_start_week_check;

ALTER TABLE leagues
    ADD CONSTRAINT leagues_playoff_start_week_check
    CHECK (playoff_start_week BETWEEN 18 AND 26);

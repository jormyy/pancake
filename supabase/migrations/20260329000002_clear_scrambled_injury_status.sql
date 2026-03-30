-- Sleeper returns "Scrambled" as a junk injury status — clear it from existing rows
UPDATE players SET injury_status = NULL WHERE injury_status = 'Scrambled';

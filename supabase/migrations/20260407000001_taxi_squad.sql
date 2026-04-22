-- Add taxi squad support
-- taxi_slots: number of taxi squad spots per team (0 = disabled)
-- is_on_taxi: whether a roster player is on the taxi squad (not counted as active, excluded from lineup)

ALTER TABLE leagues ADD COLUMN IF NOT EXISTS taxi_slots INT NOT NULL DEFAULT 0;

ALTER TABLE roster_players ADD COLUMN IF NOT EXISTS is_on_taxi BOOLEAN NOT NULL DEFAULT false;

-- Ensure a player can't be on both IR and taxi at the same time
ALTER TABLE roster_players ADD CONSTRAINT chk_not_ir_and_taxi CHECK (NOT (is_on_ir AND is_on_taxi));

-- Add invite_code to leagues table
ALTER TABLE leagues ADD COLUMN invite_code text UNIQUE;

-- Index for fast lookup by invite code (join flow)
CREATE INDEX idx_leagues_invite_code ON leagues(invite_code);

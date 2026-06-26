-- Add a distinct 'withdrawn' terminal status for auction nominations the
-- nominator takes back (vs 'no_bid' which is a timer expiry with no bids).
-- Separated into its own migration so the new enum value is committed before
-- any function/DML references it (Postgres forbids using a freshly added enum
-- value in the same transaction).

ALTER TYPE nomination_status ADD VALUE IF NOT EXISTS 'withdrawn';

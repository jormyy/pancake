-- Add push_token to profiles for Expo push notifications.
-- A single token per user (last registered device wins).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS push_token text;

-- Drop the auth.users trigger approach — profile creation is handled
-- in the application layer via signUp() in lib/auth.ts instead.
-- Trigger-based profile creation on auth.users is fragile due to
-- search_path scoping when referencing public.profiles.

DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS handle_new_user();

-- Authorize authenticated clients to join the app's private realtime channels.
--
-- Every app realtime subscription opens its channel with
-- `config: { private: true }` (lib/realtime.ts, lib/draft.ts, lib/rookieDraft.ts).
-- A private channel makes Realtime enforce an RLS check against
-- `realtime.messages` at JOIN time. With no such policy the JOIN is rejected
-- ("Unauthorized: You do not have permissions to read from this Channel topic"),
-- so postgres_changes events are never delivered and the app silently falls
-- back to focus/refetch instead of near-instant realtime.
--
-- This policy authorizes the channel JOIN for authenticated users only. It does
-- NOT widen data exposure: postgres_changes re-checks each changed row against
-- the source table's own RLS SELECT policy before delivering it, so a subscriber
-- still only ever receives rows they are already allowed to read. Anonymous
-- clients remain unauthorized (no policy for the anon role).

DROP POLICY IF EXISTS "authenticated_can_receive_realtime" ON realtime.messages;
CREATE POLICY "authenticated_can_receive_realtime" ON realtime.messages
  FOR SELECT TO authenticated
  USING (true);

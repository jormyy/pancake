-- Hoists auth.uid() in the notification_preferences policies.
--
-- A bare auth.uid() in a policy predicate is re-evaluated per scanned row;
-- wrapping it in a scalar subquery lets the planner hoist it to an InitPlan and
-- evaluate it once per statement. Every other policy in this schema already uses
-- the wrapped form -- these four were the only holdouts, and the inconsistency
-- was the kind that gets copy-pasted forward.

DROP POLICY IF EXISTS "notification_preferences_select_own" ON public.notification_preferences;
CREATE POLICY "notification_preferences_select_own" ON public.notification_preferences
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "notification_preferences_insert_own" ON public.notification_preferences;
CREATE POLICY "notification_preferences_insert_own" ON public.notification_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "notification_preferences_update_own" ON public.notification_preferences;
CREATE POLICY "notification_preferences_update_own" ON public.notification_preferences
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

SET lock_timeout = '5s';
ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notif_category_values CHECK (NOT jsonb_path_exists(category_settings, '$.* ? (@.type() != "boolean")')),
  ADD CONSTRAINT notif_event_values CHECK (NOT jsonb_path_exists(event_settings, '$.* ? (@.type() != "boolean")'));
RESET lock_timeout;

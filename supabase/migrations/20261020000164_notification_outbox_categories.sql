SET lock_timeout = '5s';
ALTER TABLE public.notification_outbox DROP CONSTRAINT notification_outbox_trade_category;
RESET lock_timeout;

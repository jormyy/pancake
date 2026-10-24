UPDATE public.notification_outbox
   SET expo_ticket_id = NULL, push_token = NULL, ticketed_at = NULL,
       claimed_at = NULL, claim_token = NULL, available_at = now()
 WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND expo_ticket_id IS NOT NULL;

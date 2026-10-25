SELECT cron.schedule('notification-dispatch-minute', '* * * * *', 'SELECT public.invoke_process_trades_if_due()');

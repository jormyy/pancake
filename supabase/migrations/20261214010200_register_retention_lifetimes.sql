BEGIN;
INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES
('private.forecast_refresh_requests','Pending forecast requests drain on processing; matchup and league deletion cascade'),
('private.live_feed_audit','Durable live-source reconciliation evidence; game deletion cascades'),
('private.live_feed_state','One source checkpoint per game; game deletion cascades'),
('private.live_hint_broadcasts','Transaction-local pending broadcasts drain at commit'),
('private.live_matchup_refresh_queue','One pending refresh per matchup; processing drains and matchup deletion cascades'),
('private.matchup_forecast_expiries','One expiry per forecast; processing drains and forecast deletion cascades'),
('private.notification_scan_dirty','Singleton wake marker clears when a scan starts'),
('private.notification_scan_state','Singleton persistent notification scan cursor'),
('private.notification_season_scan_cache','One cached opening day per season; season deletion cascades'),
('private.screen_average_dirty','One dirty marker per season and player; refresh drains and season deletion cascades'),
('private.trade_input_revisions','Trade input writer revisions compact into shared source revisions'),
('private.trade_revaluation_leagues','One pacing checkpoint per league; league deletion cascades'),
('private.trade_revaluation_schedule','One pacing checkpoint per trade; trade deletion cascades'),
('public.lineup_player_pins','Durable lineup intent; league, season, member, and player deletion cascade')
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule;
COMMIT;

UPDATE season_sim.clock SET sim_ms=extract(epoch FROM timestamptz '2026-10-28T22:00:00Z')*1000;
SELECT * FROM private.notif_lineup_candidates_scoped('2026-10-28T22:00:00Z',NULL,NULL);

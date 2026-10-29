GRANT EXECUTE ON FUNCTION private.player_identity_name(text) TO service_role;

CREATE INDEX idx_players_identity_name_lookup ON public.players(private.player_identity_name(display_name));
ANALYZE public.players;

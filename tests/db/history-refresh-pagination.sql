BEGIN;
DO $$
DECLARE
    actor_id uuid := gen_random_uuid();
    league_id uuid := gen_random_uuid();
    season_id uuid := gen_random_uuid();
    member_id uuid := gen_random_uuid();
    first_page uuid[];
    second_page uuid[];
    last_page uuid[];
    refreshed uuid[];
    following uuid[];
BEGIN
    INSERT INTO auth.users(id, email, raw_user_meta_data)
        VALUES(actor_id, actor_id::text || '@example.test', '{}');
    INSERT INTO leagues(id, name, slug, commissioner_id, status)
        VALUES(league_id, 'History refresh', league_id::text, actor_id, 'active');
    INSERT INTO league_members(id, league_id, user_id, team_name)
        VALUES(member_id, league_id, actor_id, 'History team');
    INSERT INTO league_seasons(id, league_id, season_year, is_current)
        VALUES(season_id, league_id, 2097, true);
    INSERT INTO league_activity(league_id, league_season_id, actor_member_id, event_type, title, created_at)
        SELECT league_id, season_id, member_id, 'trade_completed', 'Trade completed', now() - entry * interval '1 minute'
        FROM generate_series(1, 125) AS entry;
    PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
    SELECT array_agg(feed.id ORDER BY feed.occurred_at DESC, feed.id DESC) INTO first_page
        FROM public.get_league_activity_feed(p_league_id => league_id, p_limit => 50, p_offset => 0) AS feed;
    IF cardinality(first_page) IS DISTINCT FROM 50 THEN RAISE EXCEPTION 'First page must contain 50 rows'; END IF;
    SELECT array_agg(feed.id ORDER BY feed.occurred_at DESC, feed.id DESC) INTO second_page
        FROM public.get_league_activity_feed(p_league_id => league_id, p_limit => 50, p_offset => 50) AS feed;
    IF cardinality(second_page) IS DISTINCT FROM 50 THEN RAISE EXCEPTION 'Second page must contain 50 rows'; END IF;
    SELECT array_agg(feed.id ORDER BY feed.occurred_at DESC, feed.id DESC) INTO last_page
        FROM public.get_league_activity_feed(p_league_id => league_id, p_limit => 50, p_offset => 100) AS feed;
    IF cardinality(last_page) IS DISTINCT FROM 25 THEN RAISE EXCEPTION 'Last page must contain 25 rows'; END IF;
    SELECT array_agg(feed.id ORDER BY feed.occurred_at DESC, feed.id DESC) INTO refreshed
        FROM public.get_league_activity_feed(p_league_id => league_id, p_limit => 100, p_offset => 0) AS feed;
    IF refreshed IS DISTINCT FROM first_page || second_page THEN RAISE EXCEPTION 'Refresh must retain the first 100 rows'; END IF;
    SELECT array_agg(feed.id ORDER BY feed.occurred_at DESC, feed.id DESC) INTO following
        FROM public.get_league_activity_feed(p_league_id => league_id, p_limit => 50, p_offset => 100) AS feed;
    IF following IS DISTINCT FROM last_page THEN RAISE EXCEPTION 'Load more must resume after the refresh'; END IF;
END;
$$;
ROLLBACK;

BEGIN;
DROP FUNCTION public.get_league_activity_feed(uuid,integer,integer);
CREATE OR REPLACE FUNCTION private.activity_player_mentions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE mentions jsonb;
BEGIN
  WITH identities AS (
    SELECT NEW.related_player_id AS id
    UNION
    SELECT item.player_id FROM public.trade_items item
    JOIN public.trades trade ON trade.id=item.trade_id AND trade.league_id=NEW.league_id
    WHERE trade.id=NEW.related_trade_id AND NEW.event_type='trade_completed'
    UNION
    SELECT unnest(participant.drop_player_ids) FROM public.trade_participants participant
    JOIN public.trades trade ON trade.id=participant.trade_id AND trade.league_id=NEW.league_id
    WHERE trade.id=NEW.related_trade_id AND NEW.event_type='trade_completed'
    UNION
    SELECT unnest(ARRAY[claim.player_id,claim.drop_player_id]) FROM public.waiver_claims claim
    WHERE claim.id=NEW.related_claim_id AND claim.league_id=NEW.league_id
    UNION
    SELECT (entry->>'id')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.metadata->'player_mentions')='array' THEN NEW.metadata->'player_mentions' ELSE '[]'::jsonb END) entry
    WHERE entry->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',COALESCE(p.display_name,concat_ws(' ',p.first_name,p.last_name))) ORDER BY p.id),'[]') INTO mentions
  FROM identities JOIN public.players p ON p.id=identities.id;
  NEW.metadata:=COALESCE(NEW.metadata,'{}')||jsonb_build_object('player_mentions',mentions);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_league_activity_feed(
  p_league_id uuid,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  member_id uuid,
  target_member_id uuid,
  team_name text,
  target_team_name text,
  player_id uuid,
  player_name text,
  player_position text,
  eligible_positions text[],
  nba_id text,
  transaction_type text,
  occurred_at timestamptz,
  is_system boolean,
  title text,
  body text,
  years_exp int,
  career_regular_season_games int,
  participant_team_names text[],
  player_mentions jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE league_id = p_league_id
     AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH current_season AS (
    SELECT season.id
      FROM league_seasons AS season
     WHERE season.league_id = p_league_id
       AND season.is_current = true
     LIMIT 1
  ),
  feed AS (
    SELECT
      tx.id,
      tx.member_id,
      NULL::uuid AS target_member_id,
      member.team_name::text AS team_name,
      NULL::text AS target_team_name,
      tx.player_id,
      player.display_name::text AS player_name,
      player.position::text AS player_position,
      player.eligible_positions::text[] AS eligible_positions,
      player.nba_id::text AS nba_id,
      tx.transaction_type::text AS transaction_type,
      tx.occurred_at,
      false AS is_system,
      NULL::text AS title,
      CASE WHEN tx.acquired_to_taxi AND tx.transaction_type IN ('fa_add','waiver_add') THEN 'Player added to taxi.' ELSE NULL END::text AS body,
      player.years_exp,
      player.career_regular_season_games,
      ARRAY[]::text[] AS participant_team_names,
      CASE WHEN player.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('id',player.id,'name',player.display_name)) END AS player_mentions
    FROM roster_transactions AS tx
    JOIN current_season ON current_season.id = tx.league_season_id
    LEFT JOIN league_members AS member ON member.id = tx.member_id
    LEFT JOIN players AS player ON player.id = tx.player_id
    WHERE tx.league_id = p_league_id
      AND tx.transaction_type IN ('fa_add', 'fa_drop', 'waiver_add', 'waiver_drop', 'trade_in', 'trade_out', 'draft_won', 'carry_over')

    UNION ALL

    SELECT
      activity.id,
      activity.actor_member_id AS member_id,
      activity.target_member_id,
      COALESCE(actor.team_name, 'League')::text AS team_name,
      target.team_name::text AS target_team_name,
      activity.related_player_id AS player_id,
      COALESCE(player.display_name, activity.title)::text AS player_name,
      player.position::text AS player_position,
      player.eligible_positions::text[] AS eligible_positions,
      player.nba_id::text AS nba_id,
      activity.event_type::text AS transaction_type,
      activity.created_at AS occurred_at,
      true AS is_system,
      activity.title,
      activity.body,
      player.years_exp,
      player.career_regular_season_games,
      CASE WHEN activity.event_type = 'trade_completed' THEN
        COALESCE((SELECT array_agg(participant_member.team_name::text ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
          JOIN league_members AS participant_member ON participant_member.id = participant.member_id
            AND participant_member.league_id = activity.league_id
          WHERE participant.trade_id = activity.related_trade_id),
          array_remove(ARRAY[actor.team_name::text, target.team_name::text], NULL))
      ELSE ARRAY[]::text[] END AS participant_team_names,
      COALESCE(activity.metadata->'player_mentions','[]'::jsonb) AS player_mentions
    FROM league_activity AS activity
    JOIN current_season
      ON activity.league_season_id = current_season.id
      OR activity.league_season_id IS NULL
    LEFT JOIN league_members AS actor ON actor.id = activity.actor_member_id
    LEFT JOIN league_members AS target ON target.id = activity.target_member_id
    LEFT JOIN players AS player ON player.id = activity.related_player_id
    WHERE activity.league_id = p_league_id
      AND activity.event_type NOT IN ('trade_block_updated', 'free_agent_added',
        'trade_offered', 'trade_countered', 'trade_edited', 'trade_expired')
  )
  SELECT
    feed.id,
    feed.member_id,
    feed.target_member_id,
    feed.team_name,
    feed.target_team_name,
    feed.player_id,
    feed.player_name,
    feed.player_position,
    feed.eligible_positions,
    feed.nba_id,
    feed.transaction_type,
    feed.occurred_at,
    feed.is_system,
    feed.title,
    feed.body,
    feed.years_exp,
    feed.career_regular_season_games,
    feed.participant_team_names,
    feed.player_mentions
  FROM feed
  ORDER BY feed.occurred_at DESC, feed.id DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.view_activity(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; rows jsonb; announcements jsonb; page_size integer := LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 50), 1), 100);
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', feed.id, 'memberId', feed.member_id, 'targetMemberId', feed.target_member_id,
    'teamName', COALESCE(feed.team_name, CASE WHEN feed.is_system THEN 'League' ELSE 'Unknown' END), 'targetTeamName', feed.target_team_name,
    'playerId', feed.player_id, 'playerName', COALESCE(feed.player_name, feed.title, 'Unknown'), 'position', feed.player_position,
    'eligiblePositions', COALESCE(to_jsonb(feed.eligible_positions), CASE WHEN feed.player_position IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(feed.player_position) END),
    'nbaId', feed.nba_id, 'nbaTeam', player.nba_team, 'injuryStatus', player.injury_status, 'yearsExp', player.years_exp,
    'careerGames', player.career_regular_season_games, 'transactionType', feed.transaction_type, 'occurredAt', feed.occurred_at,
    'playerMentions', feed.player_mentions, 'isSystem', feed.is_system, 'title', feed.title, 'body', feed.body, 'participantTeamNames', feed.participant_team_names)), '[]')
  INTO rows FROM public.get_league_activity_feed(p_league_id, page_size, GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0)) feed
    LEFT JOIN public.players player ON player.id = feed.player_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(announcement) ORDER BY announcement.published_at DESC), '[]') INTO announcements
    FROM public.notif_list_announcements(p_league_id) announcement;
  RETURN jsonb_build_object('context', context, 'rows', rows, 'announcements', announcements,
    'hasMore', jsonb_array_length(rows) = page_size, 'offset', GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0) + jsonb_array_length(rows));
END;
$$;

REVOKE ALL ON FUNCTION private.activity_player_mentions() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_league_activity_feed(uuid,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_league_activity_feed(uuid,integer,integer) TO authenticated,service_role;
CREATE TRIGGER activity_player_mentions BEFORE INSERT OR UPDATE ON public.league_activity
FOR EACH ROW EXECUTE FUNCTION private.activity_player_mentions();
UPDATE public.league_activity SET metadata=metadata;
COMMIT;

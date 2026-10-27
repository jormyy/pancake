CREATE OR REPLACE FUNCTION public.generate_linear_draft_order(p_draft_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_draft drafts%ROWTYPE; v_last_season_id uuid; v_order_count integer;
BEGIN
 SELECT * INTO STRICT v_draft FROM drafts WHERE id=p_draft_id FOR UPDATE;
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT private.is_commissioner(v_draft.league_id) THEN
  RAISE EXCEPTION 'Only the commissioner can generate draft order.' USING ERRCODE='42501';
 END IF;
 SELECT count(*) INTO v_order_count FROM draft_orders WHERE draft_id=p_draft_id;
 IF v_order_count>0 THEN RETURN v_order_count; END IF;
 IF v_draft.status NOT IN ('pending','in_progress') THEN RAISE EXCEPTION 'Draft order is already locked.'; END IF;
 SELECT id INTO v_last_season_id FROM league_seasons WHERE league_id=v_draft.league_id AND NOT is_current ORDER BY season_year DESC LIMIT 1;
  WITH ordered_members AS (
    SELECT
      lm.id AS member_id,
      CASE WHEN latest.member_id IS NULL THEN 0 ELSE 1 END AS has_standings,
      (COALESCE(latest.wins, 0) + 0.5 * COALESCE(latest.ties, 0)) / GREATEST(COALESCE(latest.wins + latest.losses + latest.ties, 0), 1) AS win_rate,
      COALESCE(latest.points_for, 0) / GREATEST(COALESCE(latest.wins + latest.losses + latest.ties, 0), 1) AS points_per_game
    FROM league_members AS lm
    LEFT JOIN LATERAL (
      SELECT s.member_id, s.wins, s.losses, s.ties, s.points_for
        FROM standings AS s
       WHERE v_last_season_id IS NOT NULL
         AND s.league_id = v_draft.league_id
         AND s.league_season_id = v_last_season_id
         AND s.member_id = lm.id
       ORDER BY s.week_number DESC
       LIMIT 1
    ) AS latest ON true
    WHERE lm.league_id = v_draft.league_id
  ),
  rookie_draft_order AS (
    SELECT
      member_id,
      row_number() OVER (
        ORDER BY
          has_standings DESC,
          win_rate ASC,
          points_per_game ASC,
          md5(v_draft.order_seed::text || member_id::text) ASC,
          member_id ASC
      )::int AS position
    FROM ordered_members
  )
  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, member_id, position
    FROM rookie_draft_order
   ORDER BY position;


 GET DIAGNOSTICS v_order_count=ROW_COUNT;
 RETURN v_order_count;
END;
$$;

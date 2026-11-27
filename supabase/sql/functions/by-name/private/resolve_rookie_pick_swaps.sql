-- Canonical SQL source for private.resolve_rookie_pick_swaps.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.resolve_rookie_pick_swaps(p_draft_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_draft public.drafts%ROWTYPE;
  v_year int;
  v_swap public.draft_pick_swaps%ROWTYPE;
  v_holder record;
  v_counter record;
  v_resolved int := 0;
BEGIN
  SELECT * INTO v_draft FROM public.drafts WHERE id = p_draft_id;
  IF NOT FOUND OR v_draft.is_mock OR v_draft.draft_type <> 'snake'::public.draft_type THEN
    RETURN 0;
  END IF;
  SELECT private.draft_year_for_season(season.season_year) INTO v_year
    FROM public.league_seasons season WHERE season.id = v_draft.league_season_id;

  FOR v_swap IN
    SELECT * FROM public.draft_pick_swaps
     WHERE league_id = v_draft.league_id AND season_year = v_year AND status = 'open'
     ORDER BY created_at, id
     FOR UPDATE
  LOOP
    SELECT slot.overall_pick, slot.draft_pick_id, pick.current_owner_id
      INTO v_holder
      FROM public.snake_draft_picks slot
      JOIN public.draft_picks pick ON pick.id = slot.draft_pick_id
     WHERE slot.draft_id = p_draft_id AND slot.round = v_swap.round
       AND pick.original_owner_id = v_swap.holder_member_id
       AND slot.player_id IS NULL AND slot.skipped_at IS NULL
     LIMIT 1;
    SELECT slot.overall_pick, slot.draft_pick_id, pick.current_owner_id
      INTO v_counter
      FROM public.snake_draft_picks slot
      JOIN public.draft_picks pick ON pick.id = slot.draft_pick_id
     WHERE slot.draft_id = p_draft_id AND slot.round = v_swap.round
       AND pick.original_owner_id = v_swap.counterparty_member_id
       AND slot.player_id IS NULL AND slot.skipped_at IS NULL
     LIMIT 1;

    IF v_holder.overall_pick IS NOT NULL AND v_counter.overall_pick IS NOT NULL
       AND v_holder.current_owner_id = v_swap.holder_member_id
       AND v_counter.overall_pick < v_holder.overall_pick THEN
      UPDATE public.draft_picks
         SET current_owner_id = CASE id WHEN v_holder.draft_pick_id THEN v_counter.current_owner_id ELSE v_holder.current_owner_id END
       WHERE id IN (v_holder.draft_pick_id, v_counter.draft_pick_id);
      UPDATE public.draft_pick_swaps
         SET status = 'exercised', draft_id = p_draft_id, resolved_at = clock_timestamp(),
             holder_overall_pick = v_holder.overall_pick, counterparty_overall_pick = v_counter.overall_pick
       WHERE id = v_swap.id;
    ELSE
      UPDATE public.draft_pick_swaps
         SET status = 'unused', draft_id = p_draft_id, resolved_at = clock_timestamp(),
             holder_overall_pick = v_holder.overall_pick, counterparty_overall_pick = v_counter.overall_pick
       WHERE id = v_swap.id;
    END IF;
    v_resolved := v_resolved + 1;
  END LOOP;
  RETURN v_resolved;
END;
$$;

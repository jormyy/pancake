-- Canonical SQL source for private.prevent_pending_waiver_claim_with_ineligible_ir.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_pending_waiver_claim_with_ineligible_ir()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
DECLARE
  v_problem_kind text;
  v_problem_message text;
BEGIN
  IF NEW.status = 'pending'::waiver_claim_status THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(NEW.member_id::text));
    SELECT problem.kind,string_agg(problem.message,' ' ORDER BY problem.player_name,problem.roster_player_id)
      INTO v_problem_kind,v_problem_message
      FROM private.roster_problems(NEW.league_id,NEW.league_season_id,NEW.member_id) problem
      LEFT JOIN roster_players chosen ON chosen.id=problem.roster_player_id AND chosen.player_id=NEW.drop_player_id
     WHERE chosen.id IS NULL
     GROUP BY problem.kind ORDER BY CASE problem.kind WHEN 'ir' THEN 1 WHEN 'taxi' THEN 2 ELSE 3 END LIMIT 1;
    IF v_problem_kind IS NOT NULL THEN
      RAISE EXCEPTION '%',v_problem_message USING ERRCODE=CASE v_problem_kind WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' ELSE 'PA003' END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

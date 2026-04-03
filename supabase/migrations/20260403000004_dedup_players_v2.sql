-- ── Dedup players v2 ─────────────────────────────────────────────
-- The previous migration's Phase 2 used raw lower() comparisons which
-- missed: accented last names (Bogdanović ≠ Bogdanovic), Jr/Sr in the
-- last_name column (Jackson Jr. ≠ Jackson), and punctuation (O.G. ≠ OG).
--
-- This migration introduces a proper name_key() normalizer and re-runs
-- dedup with it, plus replaces merge_duplicate_players() so future
-- sync runs also use the improved matching.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Strip accents, lowercase, remove generational suffixes, strip non-alphanumeric
CREATE OR REPLACE FUNCTION name_key(n text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      regexp_replace(unaccent(lower(n)), '\s+(jr\.?|sr\.?|ii|iii|iv|v)$', ''),
      '[^a-z0-9 ]', '', 'g'
    ),
    '\s+', ' ', 'g'
  ))
$$;

-- Rebuild merge_duplicate_players to use name_key for Phase 2 + 3
CREATE OR REPLACE FUNCTION merge_duplicate_players()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  r RECORD;
BEGIN
  -- Phase 1: same nba_id (most reliable — same nba_id = same real person)
  FOR r IN
    SELECT
      (array_agg(id ORDER BY (sleeper_id IS NOT NULL) DESC, created_at ASC))[1] AS winner_id,
      unnest((array_agg(id ORDER BY (sleeper_id IS NOT NULL) DESC, created_at ASC))[2:]) AS loser_id
    FROM players
    WHERE nba_id IS NOT NULL
    GROUP BY nba_id
    HAVING count(*) > 1
  LOOP
    PERFORM merge_players(r.winner_id, r.loser_id);
  END LOOP;

  -- Phase 2: same normalized full name + same team
  -- Catches: accents, Jr/Sr in last name, punctuation variants (OG vs O.G.)
  FOR r IN
    SELECT DISTINCT ON (LEAST(p1.id::text, p2.id::text))
      p1.id   AS id1,
      p2.id   AS id2,
      (p1.sleeper_id IS NOT NULL)::int + (p1.nba_id IS NOT NULL)::int AS score1,
      (p2.sleeper_id IS NOT NULL)::int + (p2.nba_id IS NOT NULL)::int AS score2
    FROM players p1
    JOIN players p2
      ON p1.id < p2.id
      AND p1.nba_team IS NOT NULL
      AND p1.nba_team = p2.nba_team
      AND name_key(p1.first_name || ' ' || p1.last_name)
        = name_key(p2.first_name || ' ' || p2.last_name)
  LOOP
    IF r.score1 >= r.score2 THEN
      PERFORM merge_players(r.id1, r.id2);
    ELSE
      PERFORM merge_players(r.id2, r.id1);
    END IF;
  END LOOP;

  -- Phase 3: same normalized last name + same team + first name is prefix of other
  -- Catches: nickname variants where full-name match fails (Nic vs Nicolas)
  FOR r IN
    SELECT DISTINCT ON (LEAST(p1.id::text, p2.id::text))
      p1.id   AS id1,
      p2.id   AS id2,
      (p1.sleeper_id IS NOT NULL)::int + (p1.nba_id IS NOT NULL)::int AS score1,
      (p2.sleeper_id IS NOT NULL)::int + (p2.nba_id IS NOT NULL)::int AS score2
    FROM players p1
    JOIN players p2
      ON p1.id < p2.id
      AND p1.nba_team IS NOT NULL
      AND p1.nba_team = p2.nba_team
      AND name_key(p1.last_name) = name_key(p2.last_name)
      AND (
        name_key(p2.first_name) LIKE name_key(p1.first_name) || '%'
        OR name_key(p1.first_name) LIKE name_key(p2.first_name) || '%'
      )
  LOOP
    IF r.score1 >= r.score2 THEN
      PERFORM merge_players(r.id1, r.id2);
    ELSE
      PERFORM merge_players(r.id2, r.id1);
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION name_key(text) TO service_role, authenticated, anon;
GRANT EXECUTE ON FUNCTION merge_duplicate_players() TO service_role;

-- Run it now against current data
SELECT merge_duplicate_players();

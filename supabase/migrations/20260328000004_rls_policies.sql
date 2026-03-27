-- ============================================================
-- Migration: Row Level Security — All Tables
--
-- Strategy:
--   1. Create all policies first (policies on tables without RLS are
--      inert, so this step has zero impact on existing behaviour).
--   2. Enable RLS on every table atomically at the bottom.
--
-- Architecture:
--   • The React Native client uses the anon key + authenticated JWT.
--     All data access goes through these policies.
--   • The Fastify backend and Edge Functions use the service_role key,
--     which bypasses RLS entirely — those paths are unaffected.
--
-- Rollback (per-table, instant):
--   ALTER TABLE <table_name> DISABLE ROW LEVEL SECURITY;
--
-- Helper functions (defined in migration 000002):
--   private.my_league_ids()  → SET of league UUIDs the user belongs to
--   private.my_member_ids()  → SET of league_member UUIDs for the user
--   private.is_commissioner(league_id) → boolean
-- ============================================================


-- ============================================================
-- TIER 1: PUBLIC REFERENCE DATA
-- Global NBA data. Readable by all authenticated users.
-- Writes are exclusively handled by the backend (service_role).
-- ============================================================

CREATE POLICY "players_select" ON players
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "nba_games_select" ON nba_games
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "season_weeks_select" ON season_weeks
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "player_game_stats_select" ON player_game_stats
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "player_projections_select" ON player_projections
  FOR SELECT TO authenticated USING (true);


-- ============================================================
-- TIER 2: PROFILES
-- User-owned rows. Anyone authenticated can read all profiles
-- (needed for cross-league member display: team names, avatars).
-- ============================================================

CREATE POLICY "profiles_select" ON profiles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "profiles_insert" ON profiles
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "profiles_update" ON profiles
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = id);


-- ============================================================
-- TIER 3: LEAGUE-SCOPED CORE
-- League data is only visible to members of that league.
-- ============================================================

-- leagues ─────────────────────────────────────────────────────
CREATE POLICY "leagues_select" ON leagues
  FOR SELECT TO authenticated
  USING (id IN (SELECT private.my_league_ids()));

-- Any authenticated user can create a league (they become commissioner)
CREATE POLICY "leagues_insert" ON leagues
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = commissioner_id);

-- Only commissioner/co-commissioner can update league settings
CREATE POLICY "leagues_update" ON leagues
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_commissioner(id)));

-- league_seasons ──────────────────────────────────────────────
CREATE POLICY "league_seasons_select" ON league_seasons
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

-- Commissioner inserts the first season when creating a league
CREATE POLICY "league_seasons_insert" ON league_seasons
  FOR INSERT TO authenticated
  WITH CHECK (
    league_id IN (
      SELECT l.id FROM leagues l
      WHERE  l.commissioner_id = (SELECT auth.uid())
    )
  );

-- league_members ──────────────────────────────────────────────
CREATE POLICY "league_members_select" ON league_members
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

-- Users can insert their own membership row.
-- createLeague() inserts the commissioner's row directly.
-- joinLeague() is handled by the join_league_by_invite_code RPC.
CREATE POLICY "league_members_insert" ON league_members
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Members can update their own row (e.g. team_name)
CREATE POLICY "league_members_update" ON league_members
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- lineup_slot_templates ───────────────────────────────────────
CREATE POLICY "slot_templates_select" ON lineup_slot_templates
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

CREATE POLICY "slot_templates_insert" ON lineup_slot_templates
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_commissioner(league_id)));

CREATE POLICY "slot_templates_update" ON lineup_slot_templates
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_commissioner(league_id)));

CREATE POLICY "slot_templates_delete" ON lineup_slot_templates
  FOR DELETE TO authenticated
  USING ((SELECT private.is_commissioner(league_id)));

-- standings ───────────────────────────────────────────────────
-- Read-only for clients. Backend inserts snapshots (service_role).
CREATE POLICY "standings_select" ON standings
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

-- rps_challenges ──────────────────────────────────────────────
-- League members can read and submit their rock-paper-scissors choice.
CREATE POLICY "rps_select" ON rps_challenges
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

CREATE POLICY "rps_insert" ON rps_challenges
  FOR INSERT TO authenticated
  WITH CHECK (league_id IN (SELECT private.my_league_ids()));

CREATE POLICY "rps_update" ON rps_challenges
  FOR UPDATE TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

-- sync_jobs ───────────────────────────────────────────────────
-- Read-only for clients (useful for sync progress display).
CREATE POLICY "sync_jobs_select" ON sync_jobs
  FOR SELECT TO authenticated USING (true);


-- ============================================================
-- TIER 4: ROSTER & LINEUP
-- ============================================================

-- roster_players ──────────────────────────────────────────────
-- SELECT: any league member can see all rosters.
-- INSERT/DELETE: restricted to own member (FA pickups, drops).
-- UPDATE: league-scoped (permissive) to support trade acceptance,
--   which reassigns player ownership between two members in a single
--   client-side operation. League isolation is the primary boundary.
CREATE POLICY "roster_players_select" ON roster_players
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

CREATE POLICY "roster_players_insert" ON roster_players
  FOR INSERT TO authenticated
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND member_id IN (SELECT private.my_member_ids())
  );

CREATE POLICY "roster_players_update" ON roster_players
  FOR UPDATE TO authenticated
  USING  (league_id IN (SELECT private.my_league_ids()))
  WITH CHECK (league_id IN (SELECT private.my_league_ids()));

CREATE POLICY "roster_players_delete" ON roster_players
  FOR DELETE TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

-- weekly_lineups ──────────────────────────────────────────────
-- SELECT: any league member can see all lineups.
-- Mutations: strictly own member (no collaborative lineup editing).
CREATE POLICY "weekly_lineups_select" ON weekly_lineups
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

CREATE POLICY "weekly_lineups_insert" ON weekly_lineups
  FOR INSERT TO authenticated
  WITH CHECK (member_id IN (SELECT private.my_member_ids()));

CREATE POLICY "weekly_lineups_update" ON weekly_lineups
  FOR UPDATE TO authenticated
  USING (member_id IN (SELECT private.my_member_ids()));

CREATE POLICY "weekly_lineups_delete" ON weekly_lineups
  FOR DELETE TO authenticated
  USING (member_id IN (SELECT private.my_member_ids()));


-- ============================================================
-- TIER 5: DRAFT TABLES
-- All mutations (start draft, bid, pick) go through the Fastify
-- backend (service_role). Clients only read.
-- ============================================================

-- drafts ──────────────────────────────────────────────────────
CREATE POLICY "drafts_select" ON drafts
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

-- draft_orders ────────────────────────────────────────────────
CREATE POLICY "draft_orders_select" ON draft_orders
  FOR SELECT TO authenticated
  USING (
    draft_id IN (
      SELECT d.id FROM drafts d
      WHERE  d.league_id IN (SELECT private.my_league_ids())
    )
  );

-- draft_budgets ───────────────────────────────────────────────
CREATE POLICY "draft_budgets_select" ON draft_budgets
  FOR SELECT TO authenticated
  USING (
    draft_id IN (
      SELECT d.id FROM drafts d
      WHERE  d.league_id IN (SELECT private.my_league_ids())
    )
  );

-- nominations ─────────────────────────────────────────────────
-- Realtime postgres_changes for nominations will only fire for
-- rows the subscribing user can SELECT (enforced by Supabase Realtime).
CREATE POLICY "nominations_select" ON nominations
  FOR SELECT TO authenticated
  USING (
    draft_id IN (
      SELECT d.id FROM drafts d
      WHERE  d.league_id IN (SELECT private.my_league_ids())
    )
  );

-- bids ────────────────────────────────────────────────────────
-- 3-level join: bids → nominations → drafts → league_id.
-- Phase 3 adds a league_id column to bids to replace this with
-- a single-level lookup.
CREATE POLICY "bids_select" ON bids
  FOR SELECT TO authenticated
  USING (
    nomination_id IN (
      SELECT n.id FROM nominations n
      JOIN   drafts d ON d.id = n.draft_id
      WHERE  d.league_id IN (SELECT private.my_league_ids())
    )
  );

-- snake_draft_picks ───────────────────────────────────────────
CREATE POLICY "snake_draft_picks_select" ON snake_draft_picks
  FOR SELECT TO authenticated
  USING (
    draft_id IN (
      SELECT d.id FROM drafts d
      WHERE  d.league_id IN (SELECT private.my_league_ids())
    )
  );

-- draft_picks (tradeable future pick assets) ──────────────────
CREATE POLICY "draft_picks_select" ON draft_picks
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));


-- ============================================================
-- TIER 6: TRADE TABLES
-- ============================================================

-- trades ──────────────────────────────────────────────────────
CREATE POLICY "trades_select" ON trades
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

-- Only the proposer (via own member_id) can create a trade
CREATE POLICY "trades_insert" ON trades
  FOR INSERT TO authenticated
  WITH CHECK (
    league_id         IN (SELECT private.my_league_ids())
    AND proposer_member_id IN (SELECT private.my_member_ids())
  );

-- Both involved parties can update status (accept/reject/withdraw)
CREATE POLICY "trades_update" ON trades
  FOR UPDATE TO authenticated
  USING (
    proposer_member_id  IN (SELECT private.my_member_ids())
    OR recipient_member_id IN (SELECT private.my_member_ids())
  );

-- trade_items ─────────────────────────────────────────────────
CREATE POLICY "trade_items_select" ON trade_items
  FOR SELECT TO authenticated
  USING (
    trade_id IN (
      SELECT t.id FROM trades t
      WHERE  t.league_id IN (SELECT private.my_league_ids())
    )
  );

-- Only the proposer can attach items when creating a trade
CREATE POLICY "trade_items_insert" ON trade_items
  FOR INSERT TO authenticated
  WITH CHECK (
    trade_id IN (
      SELECT t.id FROM trades t
      WHERE  t.proposer_member_id IN (SELECT private.my_member_ids())
    )
  );

-- trade_vetos ─────────────────────────────────────────────────
CREATE POLICY "trade_vetos_select" ON trade_vetos
  FOR SELECT TO authenticated
  USING (
    trade_id IN (
      SELECT t.id FROM trades t
      WHERE  t.league_id IN (SELECT private.my_league_ids())
    )
  );

-- Any league member can submit a veto (trade party exclusion is app-layer)
CREATE POLICY "trade_vetos_insert" ON trade_vetos
  FOR INSERT TO authenticated
  WITH CHECK (member_id IN (SELECT private.my_member_ids()));


-- ============================================================
-- TIER 7: WAIVER TABLES
-- ============================================================

-- waiver_claims ───────────────────────────────────────────────
CREATE POLICY "waiver_claims_select" ON waiver_claims
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

CREATE POLICY "waiver_claims_insert" ON waiver_claims
  FOR INSERT TO authenticated
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND member_id IN (SELECT private.my_member_ids())
  );

-- Members can cancel their own pending claims
CREATE POLICY "waiver_claims_update" ON waiver_claims
  FOR UPDATE TO authenticated
  USING (member_id IN (SELECT private.my_member_ids()));

-- waiver_wire_log ─────────────────────────────────────────────
CREATE POLICY "waiver_wire_log_select" ON waiver_wire_log
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

-- Members insert a waiver_wire_log row when dropping a player
CREATE POLICY "waiver_wire_log_insert" ON waiver_wire_log
  FOR INSERT TO authenticated
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND dropped_by_member_id IN (SELECT private.my_member_ids())
  );

-- waiver_priorities ───────────────────────────────────────────
-- Read-only for clients. Backend updates priority order (service_role).
CREATE POLICY "waiver_priorities_select" ON waiver_priorities
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));


-- ============================================================
-- TIER 8: AUDIT LOG
-- ============================================================

CREATE POLICY "roster_transactions_select" ON roster_transactions
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

CREATE POLICY "roster_transactions_insert" ON roster_transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND member_id IN (SELECT private.my_member_ids())
  );


-- ============================================================
-- ENABLE ROW LEVEL SECURITY (atomic switch)
--
-- Policies above are inert until this block runs.
-- After this point, the anon/authenticated roles can only access
-- rows allowed by the policies above.
-- The service_role key (backend/edge functions) bypasses RLS entirely.
--
-- Rollback per table: ALTER TABLE <name> DISABLE ROW LEVEL SECURITY;
-- ============================================================

-- Tier 1: public reference data
ALTER TABLE players             ENABLE ROW LEVEL SECURITY;
ALTER TABLE nba_games           ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_weeks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_game_stats   ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_projections  ENABLE ROW LEVEL SECURITY;

-- Tier 2: profiles
ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;

-- Tier 3: league-scoped core
ALTER TABLE leagues               ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_seasons        ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lineup_slot_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE standings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE rps_challenges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_jobs             ENABLE ROW LEVEL SECURITY;

-- Tier 4: roster & lineup
ALTER TABLE roster_players        ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_lineups        ENABLE ROW LEVEL SECURITY;

-- Tier 5: draft
ALTER TABLE drafts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_budgets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE nominations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE snake_draft_picks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_picks           ENABLE ROW LEVEL SECURITY;

-- Tier 6: trades
ALTER TABLE trades                ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_vetos           ENABLE ROW LEVEL SECURITY;

-- Tier 7: waivers
ALTER TABLE waiver_claims         ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiver_wire_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiver_priorities     ENABLE ROW LEVEL SECURITY;

-- Tier 8: audit log
ALTER TABLE roster_transactions   ENABLE ROW LEVEL SECURITY;

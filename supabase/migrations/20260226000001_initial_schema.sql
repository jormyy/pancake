-- ============================================================
-- Migration 001: Initial Schema
-- Dynasty Fantasy Basketball App
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE league_member_role AS ENUM (
  'commissioner',
  'co_commissioner',
  'manager'
);

CREATE TYPE league_status AS ENUM (
  'setup',
  'drafting',
  'active',
  'playoffs',
  'offseason',
  'archived'
);

CREATE TYPE draft_type AS ENUM (
  'auction',
  'snake'
);

CREATE TYPE draft_status AS ENUM (
  'pending',
  'in_progress',
  'paused',
  'completed',
  'cancelled'
);

CREATE TYPE nomination_status AS ENUM (
  'open',
  'sold',
  'no_bid'
);

CREATE TYPE roster_slot_type AS ENUM (
  'PG', 'SG', 'SF', 'PF', 'C',
  'G', 'F', 'UTIL', 'BE', 'IR'
);

CREATE TYPE nba_position AS ENUM (
  'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'
);

CREATE TYPE waiver_claim_status AS ENUM (
  'pending',
  'succeeded',
  'failed_priority',
  'failed_roster',
  'cancelled'
);

CREATE TYPE trade_status AS ENUM (
  'pending',
  'accepted',
  'rejected',
  'withdrawn',
  'vetoed',
  'completed',
  'expired'
);

CREATE TYPE trade_side AS ENUM (
  'proposer',
  'recipient'
);

CREATE TYPE veto_type AS ENUM (
  'commissioner',
  'member'
);

CREATE TYPE matchup_type AS ENUM (
  'regular_season',
  'playoff_quarterfinal',
  'playoff_semifinal',
  'playoff_final'
);

CREATE TYPE rps_choice AS ENUM (
  'rock',
  'paper',
  'scissors'
);

CREATE TYPE rps_status AS ENUM (
  'pending',
  'completed'
);

-- ============================================================
-- TABLES
-- (ordered by foreign key dependency)
-- ============================================================

-- ----------------------------------------------------------
-- profiles
-- Extends Supabase auth.users. One row per registered user.
-- ----------------------------------------------------------
CREATE TABLE profiles (
  id            uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      text        NOT NULL UNIQUE,
  display_name  text,
  avatar_url    text,
  timezone      text        NOT NULL DEFAULT 'America/New_York',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------
-- leagues
-- Root entity. Persists across seasons.
-- roster_size = active slots (default 20)
-- ir_slots    = IR slots (default 2); total = roster_size + ir_slots
-- scoring_settings = JSONB map: { stat_key: point_value }
--   e.g. {"points": 1, "rebounds": 1.2, "assists": 1.5,
--          "steals": 3, "blocks": 3, "turnovers": -1,
--          "three_pointers_made": 0.5, "triple_double_bonus": 5}
-- ----------------------------------------------------------
CREATE TABLE leagues (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  slug                text        NOT NULL UNIQUE,
  status              league_status NOT NULL DEFAULT 'setup',
  commissioner_id     uuid        NOT NULL REFERENCES profiles(id),
  roster_size         int         NOT NULL DEFAULT 20,
  ir_slots            int         NOT NULL DEFAULT 2,
  auction_budget      int         NOT NULL DEFAULT 200,
  scoring_settings    jsonb       NOT NULL DEFAULT '{}',
  playoff_start_week  int         NOT NULL DEFAULT 20
                        CHECK (playoff_start_week BETWEEN 18 AND 22),
  trade_deadline      date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------
-- league_seasons
-- Per-season data. One row per year per league.
-- ----------------------------------------------------------
CREATE TABLE league_seasons (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid        NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season_year           int         NOT NULL,
  is_current            boolean     NOT NULL DEFAULT false,
  regular_season_start  date,
  regular_season_end    date,
  nba_trade_deadline    date,
  created_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, season_year)
);

-- Only one current season per league
CREATE UNIQUE INDEX idx_one_current_season
  ON league_seasons(league_id)
  WHERE is_current = true;

-- ----------------------------------------------------------
-- league_members
-- One row per manager per league. Persists across seasons.
-- ----------------------------------------------------------
CREATE TABLE league_members (
  id          uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid              NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id     uuid              NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        league_member_role NOT NULL DEFAULT 'manager',
  team_name   text,
  joined_at   timestamptz       NOT NULL DEFAULT now(),

  UNIQUE (league_id, user_id)
);

-- ----------------------------------------------------------
-- lineup_slot_templates
-- Defines starting slot layout per league (commissioner-configurable).
-- Default is seeded by trigger on league insert (see migration 003).
-- Default: PG×1, SG×1, SF×1, PF×1, C×1, G×1, F×1, UTIL×1, BE×12, IR×2
-- ----------------------------------------------------------
CREATE TABLE lineup_slot_templates (
  id          uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid              NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  slot_type   roster_slot_type  NOT NULL,
  slot_count  int               NOT NULL DEFAULT 1 CHECK (slot_count > 0),

  UNIQUE (league_id, slot_type)
);

-- ----------------------------------------------------------
-- players
-- Canonical NBA player list. Synced from SportsData.io.
-- Shared across all leagues.
-- ----------------------------------------------------------
CREATE TABLE players (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sportsdata_id   text          NOT NULL UNIQUE,
  first_name      text          NOT NULL,
  last_name       text          NOT NULL,
  display_name    text          GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  nba_team        text,
  position        nba_position,
  jersey_number   text,
  status          text,
  injury_status   text,
  headshot_url    text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------
-- roster_players
-- Authoritative record of player ownership per league per season.
-- A player can only be on one roster per league per season.
-- is_on_ir=true: occupies an IR slot, frees up an active slot.
-- ----------------------------------------------------------
CREATE TABLE roster_players (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid        NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid        NOT NULL REFERENCES league_seasons(id),
  member_id         uuid        NOT NULL REFERENCES league_members(id),
  player_id         uuid        NOT NULL REFERENCES players(id),
  is_on_ir          boolean     NOT NULL DEFAULT false,
  acquired_at       timestamptz NOT NULL DEFAULT now(),
  acquired_via      text        NOT NULL,
  -- 'draft' | 'waiver' | 'trade' | 'free_agent'
  acquisition_cost  int,
  -- auction price if acquired_via = 'draft'; NULL otherwise

  UNIQUE (league_id, league_season_id, player_id)
);

-- ----------------------------------------------------------
-- weekly_lineups
-- A manager's submitted lineup for a given week.
-- One row per player per week. Updated in place for mid-week changes.
-- ----------------------------------------------------------
CREATE TABLE weekly_lineups (
  id                uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid              NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid              NOT NULL REFERENCES league_seasons(id),
  member_id         uuid              NOT NULL REFERENCES league_members(id),
  player_id         uuid              NOT NULL REFERENCES players(id),
  week_number       int               NOT NULL,
  slot_type         roster_slot_type  NOT NULL,
  is_auto_set       boolean           NOT NULL DEFAULT false,
  set_at            timestamptz       NOT NULL DEFAULT now(),

  UNIQUE (league_id, league_season_id, member_id, player_id, week_number)
);

-- ----------------------------------------------------------
-- nba_games
-- NBA schedule and results. Synced from SportsData.io.
-- ----------------------------------------------------------
CREATE TABLE nba_games (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sportsdata_game_id  text        NOT NULL UNIQUE,
  season_year         int         NOT NULL,
  game_date           date        NOT NULL,
  week_number         int         NOT NULL,
  home_team           text        NOT NULL,
  away_team           text        NOT NULL,
  status              text        NOT NULL,
  -- 'Scheduled' | 'InProgress' | 'Final'
  started_at          timestamptz,
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------
-- season_weeks
-- Canonical week-number-to-date mapping per season.
-- ----------------------------------------------------------
CREATE TABLE season_weeks (
  id            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  season_year   int   NOT NULL,
  week_number   int   NOT NULL,
  week_start    date  NOT NULL,
  week_end      date  NOT NULL,

  UNIQUE (season_year, week_number)
);

-- ----------------------------------------------------------
-- player_game_stats
-- Raw box score per player per game. Fantasy points are
-- computed at query time using each league's scoring_settings.
-- ----------------------------------------------------------
CREATE TABLE player_game_stats (
  id                          uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id                   uuid      NOT NULL REFERENCES players(id),
  game_id                     uuid      NOT NULL REFERENCES nba_games(id),
  season_year                 int       NOT NULL,
  week_number                 int       NOT NULL,

  minutes_played              numeric(5,2),
  points                      int,
  rebounds                    int,
  offensive_rebounds          int,
  defensive_rebounds          int,
  assists                     int,
  steals                      int,
  blocks                      int,
  turnovers                   int,
  personal_fouls              int,
  field_goals_made            int,
  field_goals_attempted       int,
  three_pointers_made         int,
  three_pointers_attempted    int,
  free_throws_made            int,
  free_throws_attempted       int,
  plus_minus                  int,
  double_double               boolean,
  triple_double               boolean,
  did_not_play                boolean   NOT NULL DEFAULT false,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (player_id, game_id)
);

-- ----------------------------------------------------------
-- player_projections
-- Weekly projections from SportsData.io. Used for auto-set.
-- ----------------------------------------------------------
CREATE TABLE player_projections (
  id                uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         uuid      NOT NULL REFERENCES players(id),
  season_year       int       NOT NULL,
  week_number       int       NOT NULL,
  projected_points  numeric(8,2),
  projected_minutes numeric(5,2),
  fetched_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (player_id, season_year, week_number)
);

-- ----------------------------------------------------------
-- matchups
-- H2H weekly matchups. One row per pair per week.
-- max_possible_points: best lineup from that manager's actual
-- roster (computed post-week for tiebreaker purposes).
-- ----------------------------------------------------------
CREATE TABLE matchups (
  id                          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id                   uuid          NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id            uuid          NOT NULL REFERENCES league_seasons(id),
  week_number                 int           NOT NULL,
  matchup_type                matchup_type  NOT NULL DEFAULT 'regular_season',
  home_member_id              uuid          NOT NULL REFERENCES league_members(id),
  away_member_id              uuid          NOT NULL REFERENCES league_members(id),
  home_points                 numeric(10,2),
  away_points                 numeric(10,2),
  home_max_possible_points    numeric(10,2),
  away_max_possible_points    numeric(10,2),
  winner_member_id            uuid          REFERENCES league_members(id),
  is_finalized                boolean       NOT NULL DEFAULT false,
  finalized_at                timestamptz,
  created_at                  timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (league_id, league_season_id, week_number, home_member_id, away_member_id),
  CHECK (home_member_id <> away_member_id)
);

-- ----------------------------------------------------------
-- standings
-- Append-only weekly snapshot. Current = latest week_number.
-- waiver_priority is snapshotted here so we have history.
-- ----------------------------------------------------------
CREATE TABLE standings (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid        NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id      uuid        NOT NULL REFERENCES league_seasons(id),
  member_id             uuid        NOT NULL REFERENCES league_members(id),
  week_number           int         NOT NULL,
  wins                  int         NOT NULL DEFAULT 0,
  losses                int         NOT NULL DEFAULT 0,
  ties                  int         NOT NULL DEFAULT 0,
  points_for            numeric(12,2) NOT NULL DEFAULT 0,
  points_against        numeric(12,2) NOT NULL DEFAULT 0,
  max_possible_points   numeric(12,2) NOT NULL DEFAULT 0,
  waiver_priority       int         NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, league_season_id, member_id, week_number)
);

-- ----------------------------------------------------------
-- rps_challenges
-- Rock paper scissors mini-game for the final standings tiebreaker.
-- A tie result creates a new challenge row.
-- ----------------------------------------------------------
CREATE TABLE rps_challenges (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid        NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid        NOT NULL REFERENCES league_seasons(id),
  member_a_id       uuid        NOT NULL REFERENCES league_members(id),
  member_b_id       uuid        NOT NULL REFERENCES league_members(id),
  member_a_choice   rps_choice,
  member_b_choice   rps_choice,
  winner_member_id  uuid        REFERENCES league_members(id),
  -- NULL = tie (a new rps_challenge row is created)
  status            rps_status  NOT NULL DEFAULT 'pending',
  context           text,
  -- e.g. 'standings_week_22_tiebreaker'
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,

  CHECK (member_a_id <> member_b_id)
);

-- ----------------------------------------------------------
-- drafts
-- One row per draft event (initial auction or annual rookie draft).
-- ----------------------------------------------------------
CREATE TABLE drafts (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid          NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid          NOT NULL REFERENCES league_seasons(id),
  draft_type        draft_type    NOT NULL DEFAULT 'auction',
  status            draft_status  NOT NULL DEFAULT 'pending',
  budget_per_team   int,
  scheduled_at      timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------
-- draft_orders
-- Nomination order for auction drafts, or pick order for snake drafts.
-- ----------------------------------------------------------
CREATE TABLE draft_orders (
  id        uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id  uuid  NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  member_id uuid  NOT NULL REFERENCES league_members(id),
  position  int   NOT NULL,

  UNIQUE (draft_id, member_id),
  UNIQUE (draft_id, position)
);

-- ----------------------------------------------------------
-- draft_budgets
-- Tracks remaining auction budget per manager.
-- ----------------------------------------------------------
CREATE TABLE draft_budgets (
  id              uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid  NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  member_id       uuid  NOT NULL REFERENCES league_members(id),
  initial_budget  int   NOT NULL,
  remaining       int   NOT NULL,

  UNIQUE (draft_id, member_id)
);

-- ----------------------------------------------------------
-- nominations
-- Active bidding item in an auction draft.
-- countdown_expires_at resets 30s after each bid (server-authoritative).
-- no_bid: player becomes a free agent immediately.
-- ----------------------------------------------------------
CREATE TABLE nominations (
  id                    uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id              uuid                NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  nominating_member_id  uuid                NOT NULL REFERENCES league_members(id),
  player_id             uuid                NOT NULL REFERENCES players(id),
  nomination_order      int                 NOT NULL,
  status                nomination_status   NOT NULL DEFAULT 'open',
  current_bid_amount    int                 NOT NULL DEFAULT 1,
  current_bidder_id     uuid                REFERENCES league_members(id),
  countdown_expires_at  timestamptz,
  winning_member_id     uuid                REFERENCES league_members(id),
  final_price           int,
  nominated_at          timestamptz         NOT NULL DEFAULT now(),
  closed_at             timestamptz,

  UNIQUE (draft_id, player_id)
);

-- ----------------------------------------------------------
-- bids
-- Immutable bid history per nomination.
-- ----------------------------------------------------------
CREATE TABLE bids (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nomination_id   uuid        NOT NULL REFERENCES nominations(id) ON DELETE CASCADE,
  member_id       uuid        NOT NULL REFERENCES league_members(id),
  amount          int         NOT NULL CHECK (amount >= 1),
  placed_at       timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------
-- snake_draft_picks
-- Pick slots for snake-format rookie drafts.
-- player_id is NULL until the pick is made.
-- ----------------------------------------------------------
CREATE TABLE snake_draft_picks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid        NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall_pick    int         NOT NULL,
  round           int         NOT NULL,
  pick_in_round   int         NOT NULL,
  member_id       uuid        NOT NULL REFERENCES league_members(id),
  player_id       uuid        REFERENCES players(id),
  picked_at       timestamptz,

  UNIQUE (draft_id, overall_pick)
);

-- ----------------------------------------------------------
-- draft_picks
-- Future draft pick assets. Tradeable.
-- Created eagerly for 5 seasons out when a league is formed.
-- Trading a pick updates current_owner_id only.
-- ----------------------------------------------------------
CREATE TABLE draft_picks (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id           uuid        NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season_year         int         NOT NULL,
  round               int         NOT NULL,
  original_owner_id   uuid        NOT NULL REFERENCES league_members(id),
  current_owner_id    uuid        NOT NULL REFERENCES league_members(id),
  is_used             boolean     NOT NULL DEFAULT false,
  used_at             timestamptz,
  rookie_draft_id     uuid        REFERENCES drafts(id),
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, season_year, round, original_owner_id)
);

-- ----------------------------------------------------------
-- waiver_priorities
-- Current priority order per manager per season.
-- Lower number = higher priority (1 = first pick).
-- Claiming moves you to the back; no season resets.
-- ----------------------------------------------------------
CREATE TABLE waiver_priorities (
  id                uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid  NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid  NOT NULL REFERENCES league_seasons(id),
  member_id         uuid  NOT NULL REFERENCES league_members(id),
  priority          int   NOT NULL,

  UNIQUE (league_id, league_season_id, member_id),
  UNIQUE (league_id, league_season_id, priority)
);

-- ----------------------------------------------------------
-- waiver_claims
-- A manager's request to claim a player off waivers.
-- process_date determines which daily run handles this claim.
-- ----------------------------------------------------------
CREATE TABLE waiver_claims (
  id                      uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id               uuid                  NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id        uuid                  NOT NULL REFERENCES league_seasons(id),
  member_id               uuid                  NOT NULL REFERENCES league_members(id),
  player_id               uuid                  NOT NULL REFERENCES players(id),
  drop_player_id          uuid                  REFERENCES players(id),
  priority_at_submission  int                   NOT NULL,
  status                  waiver_claim_status   NOT NULL DEFAULT 'pending',
  submitted_at            timestamptz           NOT NULL DEFAULT now(),
  process_date            date                  NOT NULL,
  processed_at            timestamptz,
  failure_reason          text
);

-- ----------------------------------------------------------
-- waiver_wire_log
-- Append-only log of when players enter and exit waivers.
-- clears_at = placed_on_waivers_at + 48 hours.
-- ----------------------------------------------------------
CREATE TABLE waiver_wire_log (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid        NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id      uuid        NOT NULL REFERENCES league_seasons(id),
  player_id             uuid        NOT NULL REFERENCES players(id),
  dropped_by_member_id  uuid        REFERENCES league_members(id),
  placed_on_waivers_at  timestamptz NOT NULL DEFAULT now(),
  clears_at             timestamptz NOT NULL,
  cleared_at            timestamptz,
  claimed_by_claim_id   uuid        REFERENCES waiver_claims(id)
);

-- ----------------------------------------------------------
-- trades
-- Header record for a 2-team trade proposal.
-- veto_window_expires_at = accepted_at + 24 hours.
-- Trade is killed if commissioner vetoes OR >=50% of other
-- league members veto (enforced at application layer).
-- ----------------------------------------------------------
CREATE TABLE trades (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id               uuid          NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id        uuid          NOT NULL REFERENCES league_seasons(id),
  proposer_member_id      uuid          NOT NULL REFERENCES league_members(id),
  recipient_member_id     uuid          NOT NULL REFERENCES league_members(id),
  status                  trade_status  NOT NULL DEFAULT 'pending',
  notes                   text,
  proposed_at             timestamptz   NOT NULL DEFAULT now(),
  accepted_at             timestamptz,
  veto_window_expires_at  timestamptz,
  completed_at            timestamptz,
  vetoed_at               timestamptz,

  CHECK (proposer_member_id <> recipient_member_id)
);

-- ----------------------------------------------------------
-- trade_items
-- Line items within a trade. Each row is one asset (player or pick).
-- side = which party is GIVING this asset.
-- ----------------------------------------------------------
CREATE TABLE trade_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id    uuid        NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  side        trade_side  NOT NULL,
  player_id   uuid        REFERENCES players(id),
  pick_id     uuid        REFERENCES draft_picks(id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CHECK (
    (player_id IS NOT NULL AND pick_id IS NULL) OR
    (player_id IS NULL AND pick_id IS NOT NULL)
  )
);

-- ----------------------------------------------------------
-- trade_vetos
-- Individual veto actions during the 24-hour veto window.
-- One per member per trade enforced by UNIQUE constraint.
-- ----------------------------------------------------------
CREATE TABLE trade_vetos (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id    uuid        NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  member_id   uuid        NOT NULL REFERENCES league_members(id),
  veto_type   veto_type   NOT NULL,
  vetoed_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (trade_id, member_id)
);

-- ----------------------------------------------------------
-- roster_transactions
-- Append-only audit log of all roster moves.
-- ----------------------------------------------------------
CREATE TABLE roster_transactions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid        NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id      uuid        NOT NULL REFERENCES league_seasons(id),
  member_id             uuid        NOT NULL REFERENCES league_members(id),
  player_id             uuid        NOT NULL REFERENCES players(id),
  transaction_type      text        NOT NULL,
  -- 'draft_won' | 'waiver_add' | 'waiver_drop' | 'fa_add' | 'fa_drop'
  -- 'trade_in'  | 'trade_out'  | 'ir_designate' | 'ir_return'
  related_trade_id      uuid        REFERENCES trades(id),
  related_claim_id      uuid        REFERENCES waiver_claims(id),
  related_nomination_id uuid        REFERENCES nominations(id),
  occurred_at           timestamptz NOT NULL DEFAULT now()
);

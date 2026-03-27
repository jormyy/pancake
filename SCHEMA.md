# Dynasty Fantasy Basketball App — Database Schema

## Design Decisions

- **Stack**: Supabase (PostgreSQL). All PKs are `uuid`.
- **Auth**: Supabase Auth handles authentication. `profiles` extends `auth.users`.
- **Roster size**: 20 active + 2 IR = 22 total slots per manager.
- **Scoring**: Stored as JSONB on the league row (flexible, no migration needed to add stats).
- **Fantasy points**: NOT stored on game stats — computed at query time per league scoring settings. A cache table can be added for performance later.
- **Standings**: Append-only snapshot per week (fast reads, historical record).
- **Draft picks**: Created eagerly for 5 years out. Trading a pick just updates `current_owner_id`.
- **Trades**: 2-team only.
- **Rookie draft**: Snake format.
- **No-bid auction**: Player immediately becomes a free agent.
- **Rock paper scissors tiebreaker**: In-app mini-game with its own table.

---

## Enums

```sql
CREATE TYPE league_member_role AS ENUM ('commissioner', 'co_commissioner', 'manager');
CREATE TYPE league_status AS ENUM ('setup', 'drafting', 'active', 'playoffs', 'offseason', 'archived');
CREATE TYPE draft_type AS ENUM ('auction', 'snake');
CREATE TYPE draft_status AS ENUM ('pending', 'in_progress', 'paused', 'completed', 'cancelled');
CREATE TYPE nomination_status AS ENUM ('open', 'sold', 'no_bid');
CREATE TYPE roster_slot_type AS ENUM ('PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR');
CREATE TYPE nba_position AS ENUM ('PG', 'SG', 'SF', 'PF', 'C', 'G', 'F');
CREATE TYPE waiver_claim_status AS ENUM ('pending', 'succeeded', 'failed_priority', 'failed_roster', 'cancelled');
CREATE TYPE trade_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn', 'vetoed', 'completed', 'expired');
CREATE TYPE trade_side AS ENUM ('proposer', 'recipient');
CREATE TYPE veto_type AS ENUM ('commissioner', 'member');
CREATE TYPE matchup_type AS ENUM ('regular_season', 'playoff_quarterfinal', 'playoff_semifinal', 'playoff_final');
CREATE TYPE rps_choice AS ENUM ('rock', 'paper', 'scissors');
CREATE TYPE rps_status AS ENUM ('pending', 'completed');
```

---

## Tables

### profiles

Extends Supabase `auth.users`. One row per registered user.

```sql
CREATE TABLE profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      text NOT NULL UNIQUE,
  display_name  text,
  avatar_url    text,
  timezone      text NOT NULL DEFAULT 'America/New_York',
  push_token    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

---

### leagues

Root entity. Persists across seasons.

```sql
CREATE TABLE leagues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  slug                text NOT NULL UNIQUE,
  status              league_status NOT NULL DEFAULT 'setup',
  commissioner_id     uuid NOT NULL REFERENCES profiles(id),

  -- Roster config
  roster_size         int NOT NULL DEFAULT 20,   -- active slots
  ir_slots            int NOT NULL DEFAULT 2,    -- IR slots (roster_size + ir_slots = total)

  -- Auction draft budget
  auction_budget      int NOT NULL DEFAULT 200,

  -- Scoring: { stat_key: point_value }
  -- e.g. {"points": 1, "rebounds": 1.2, "assists": 1.5, "steals": 3,
  --        "blocks": 3, "turnovers": -1, "three_pointers_made": 0.5, "triple_double_bonus": 5}
  scoring_settings    jsonb NOT NULL DEFAULT '{}',

  -- Playoff config
  playoff_start_week  int NOT NULL DEFAULT 20,   -- commissioner can set 18–22

  -- Trade deadline (NBA deadline + 14 days, set when season is created)
  trade_deadline      date,

  -- Invite code for joining the league
  invite_code         text UNIQUE,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

---

### league_seasons

Per-season data for a league. Dynasty leagues have one row per year.

```sql
CREATE TABLE league_seasons (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season_year           int NOT NULL,             -- e.g. 2025 for the 2025-26 NBA season
  is_current            boolean NOT NULL DEFAULT false,
  regular_season_start  date,
  regular_season_end    date,
  nba_trade_deadline    date,
  created_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, season_year)
);

-- Only one current season per league
CREATE UNIQUE INDEX idx_one_current_season ON league_seasons(league_id) WHERE is_current = true;
```

---

### league_members

One row per manager per league. Persists across seasons (dynasty).

```sql
CREATE TABLE league_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        league_member_role NOT NULL DEFAULT 'manager',
  team_name   text,
  joined_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, user_id)
);
```

---

### lineup_slot_templates

Defines the starting slot layout for a league (configurable per commissioner, with defaults).

Default template (22 total = 10 starters + 10 bench + 2 IR):

- PG×1, SG×1, SF×1, PF×1, C×1, G×1, F×1, UTIL×3 = 10 starters
- BE×10 bench
- IR×2

```sql
CREATE TABLE lineup_slot_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id     uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  slot_type     roster_slot_type NOT NULL,
  slot_count    int NOT NULL DEFAULT 1 CHECK (slot_count > 0),

  UNIQUE (league_id, slot_type)
);
```

---

### players

Canonical NBA player list. Synced from NBA CDN and Sleeper API. Shared across all leagues.

```sql
CREATE TABLE players (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sportsdata_id   text NOT NULL UNIQUE,
  sleeper_id      text UNIQUE,
  nba_id          text UNIQUE,
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  display_name    text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  nba_team        text,                           -- abbreviation, NULL if FA / G-League
  position        nba_position,
  jersey_number   text,
  status          text,                           -- 'Active', 'Injured', etc.
  injury_status   text,                           -- 'Questionable', 'Doubtful', 'Out', 'IR'
  headshot_url    text,
  dynasty_rank    integer,                        -- from hashtagbasketball.com, NULL if unranked
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

---

### roster_players

Authoritative record of who owns which player in which league + season.

```sql
CREATE TABLE roster_players (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid NOT NULL REFERENCES league_seasons(id),
  member_id         uuid NOT NULL REFERENCES league_members(id),
  player_id         uuid NOT NULL REFERENCES players(id),
  is_on_ir          boolean NOT NULL DEFAULT false,   -- true = occupies an IR slot, not active slot
  acquired_at       timestamptz NOT NULL DEFAULT now(),
  acquired_via      text NOT NULL,                    -- 'draft', 'waiver', 'trade', 'free_agent'
  acquisition_cost  int,                              -- auction price if acquired via draft

  UNIQUE (league_id, league_season_id, player_id)    -- player on exactly one roster per league per season
);
```

---

### weekly_lineups

A manager's active lineup for a given game date. One row per player-slot per day.
Mid-week changes update existing rows.

```sql
CREATE TABLE weekly_lineups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid NOT NULL REFERENCES league_seasons(id),
  member_id         uuid NOT NULL REFERENCES league_members(id),
  player_id         uuid NOT NULL REFERENCES players(id),
  week_number       int NOT NULL,
  game_date         date NOT NULL,
  slot_type         roster_slot_type NOT NULL,
  is_auto_set       boolean NOT NULL DEFAULT false,
  set_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, league_season_id, member_id, player_id, game_date)
);
```

---

### nba_games

NBA game schedule and results. Synced from NBA CDN.

```sql
CREATE TABLE nba_games (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sportsdata_game_id  text NOT NULL UNIQUE,
  nba_game_id         text UNIQUE,
  season_year         int NOT NULL,
  game_date           date NOT NULL,
  week_number         int NOT NULL,
  home_team           text NOT NULL,
  away_team           text NOT NULL,
  status              text NOT NULL,              -- 'Scheduled', 'InProgress', 'Final'
  started_at          timestamptz,
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

---

### season_weeks

Canonical week-number-to-date mapping per season.

```sql
CREATE TABLE season_weeks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_year   int NOT NULL,
  week_number   int NOT NULL,
  week_start    date NOT NULL,
  week_end      date NOT NULL,

  UNIQUE (season_year, week_number)
);
```

---

### player_game_stats

Raw box score stats per player per game. Fantasy points are computed at query time.

```sql
CREATE TABLE player_game_stats (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id                 uuid NOT NULL REFERENCES players(id),
  game_id                   uuid NOT NULL REFERENCES nba_games(id),
  season_year               int NOT NULL,
  week_number               int NOT NULL,

  minutes_played            numeric(5,2),
  points                    int,
  rebounds                  int,
  offensive_rebounds        int,
  defensive_rebounds        int,
  assists                   int,
  steals                    int,
  blocks                    int,
  turnovers                 int,
  personal_fouls            int,
  field_goals_made          int,
  field_goals_attempted     int,
  three_pointers_made       int,
  three_pointers_attempted  int,
  free_throws_made          int,
  free_throws_attempted     int,
  plus_minus                int,
  double_double             boolean,
  triple_double             boolean,
  did_not_play              boolean NOT NULL DEFAULT false,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  UNIQUE (player_id, game_id)
);
```

---

### player_projections

Weekly projections computed from rolling averages. Used for auto-set lineup logic.

```sql
CREATE TABLE player_projections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         uuid NOT NULL REFERENCES players(id),
  season_year       int NOT NULL,
  week_number       int NOT NULL,
  projected_points  numeric(8,2),
  projected_minutes numeric(5,2),
  fetched_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (player_id, season_year, week_number)
);
```

---

### matchups

H2H weekly matchups. One row per pair per week.

```sql
CREATE TABLE matchups (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id                   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id            uuid NOT NULL REFERENCES league_seasons(id),
  week_number                 int NOT NULL,
  matchup_type                matchup_type NOT NULL DEFAULT 'regular_season',

  home_member_id              uuid NOT NULL REFERENCES league_members(id),
  away_member_id              uuid NOT NULL REFERENCES league_members(id),

  home_points                 numeric(10,2),
  away_points                 numeric(10,2),

  -- Tiebreaker data (computed at week finalization)
  home_max_possible_points    numeric(10,2),     -- best lineup from home's actual roster
  away_max_possible_points    numeric(10,2),

  winner_member_id            uuid REFERENCES league_members(id),
  is_finalized                boolean NOT NULL DEFAULT false,
  finalized_at                timestamptz,

  created_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, league_season_id, week_number, home_member_id, away_member_id),
  CHECK (home_member_id <> away_member_id)
);
```

---

### standings

Append-only weekly standings snapshot. Current standings = latest week_number.

```sql
CREATE TABLE standings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id      uuid NOT NULL REFERENCES league_seasons(id),
  member_id             uuid NOT NULL REFERENCES league_members(id),
  week_number           int NOT NULL,

  wins                  int NOT NULL DEFAULT 0,
  losses                int NOT NULL DEFAULT 0,
  ties                  int NOT NULL DEFAULT 0,
  points_for            numeric(12,2) NOT NULL DEFAULT 0,
  points_against        numeric(12,2) NOT NULL DEFAULT 0,
  max_possible_points   numeric(12,2) NOT NULL DEFAULT 0,
  waiver_priority       int NOT NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, league_season_id, member_id, week_number)
);
```

---

### rps_challenges

Rock paper scissors mini-game for the final standings tiebreaker.

```sql
CREATE TABLE rps_challenges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid NOT NULL REFERENCES league_seasons(id),
  member_a_id       uuid NOT NULL REFERENCES league_members(id),
  member_b_id       uuid NOT NULL REFERENCES league_members(id),
  member_a_choice   rps_choice,
  member_b_choice   rps_choice,
  winner_member_id  uuid REFERENCES league_members(id),   -- NULL = tie (re-challenge)
  status            rps_status NOT NULL DEFAULT 'pending',
  context           text,                                  -- e.g. 'standings_week_22_tiebreaker'
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,

  CHECK (member_a_id <> member_b_id)
);
```

---

### drafts

One row per draft event (initial auction or annual rookie draft).

```sql
CREATE TABLE drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid NOT NULL REFERENCES league_seasons(id),
  draft_type        draft_type NOT NULL DEFAULT 'auction',
  status            draft_status NOT NULL DEFAULT 'pending',
  budget_per_team   int,                           -- auction only
  current_nomination_order int NOT NULL DEFAULT 1, -- tracks rotation position in auction
  scheduled_at      timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

---

### draft_orders

Nomination order for auction drafts, or pick order for snake drafts.

```sql
CREATE TABLE draft_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id              uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  member_id             uuid NOT NULL REFERENCES league_members(id),
  position              int NOT NULL,             -- 1-based

  UNIQUE (draft_id, member_id),
  UNIQUE (draft_id, position)
);
```

---

### draft_budgets

Tracks remaining auction budget per manager.

```sql
CREATE TABLE draft_budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES league_members(id),
  initial_budget  int NOT NULL,
  remaining       int NOT NULL,

  UNIQUE (draft_id, member_id)
);
```

---

### nominations

Active bidding item in an auction draft. One row per player nomination.

```sql
CREATE TABLE nominations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id              uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  nominating_member_id  uuid NOT NULL REFERENCES league_members(id),
  player_id             uuid NOT NULL REFERENCES players(id),
  nomination_order      int NOT NULL,             -- sequential across the draft
  status                nomination_status NOT NULL DEFAULT 'open',

  -- Live auction state
  current_bid_amount    int NOT NULL DEFAULT 1,
  current_bidder_id     uuid REFERENCES league_members(id),
  countdown_expires_at  timestamptz,             -- resets 30s after each bid (server-authoritative)

  -- Resolution
  winning_member_id     uuid REFERENCES league_members(id),
  final_price           int,

  nominated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,

  UNIQUE (draft_id, player_id)                  -- player can only be nominated once per draft
);
```

---

### bids

Immutable bid history per nomination.

```sql
CREATE TABLE bids (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nomination_id   uuid NOT NULL REFERENCES nominations(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES league_members(id),
  amount          int NOT NULL CHECK (amount >= 1),
  placed_at       timestamptz NOT NULL DEFAULT now()
);
```

---

### snake_draft_picks

Picks for snake-format rookie drafts. One row per pick slot.

```sql
CREATE TABLE snake_draft_picks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall_pick    int NOT NULL,
  round           int NOT NULL,
  pick_in_round   int NOT NULL,
  member_id       uuid NOT NULL REFERENCES league_members(id),
  player_id       uuid REFERENCES players(id),   -- NULL until the pick is made
  picked_at       timestamptz,

  UNIQUE (draft_id, overall_pick)
);
```

---

### draft_picks

Future draft pick assets. Tradeable. Created eagerly for the next 5 seasons on league creation.

```sql
CREATE TABLE draft_picks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id           uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season_year         int NOT NULL,
  round               int NOT NULL,
  original_owner_id   uuid NOT NULL REFERENCES league_members(id),
  current_owner_id    uuid NOT NULL REFERENCES league_members(id),
  is_used             boolean NOT NULL DEFAULT false,
  used_at             timestamptz,
  rookie_draft_id     uuid REFERENCES drafts(id),

  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (league_id, season_year, round, original_owner_id)
);
```

---

### waiver_priorities

Current waiver priority per manager per season. Lower number = higher priority.

```sql
CREATE TABLE waiver_priorities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id  uuid NOT NULL REFERENCES league_seasons(id),
  member_id         uuid NOT NULL REFERENCES league_members(id),
  priority          int NOT NULL,

  UNIQUE (league_id, league_season_id, member_id),
  UNIQUE (league_id, league_season_id, priority)
);
```

---

### waiver_claims

A manager's request to claim a player off waivers.

```sql
CREATE TABLE waiver_claims (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id               uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id        uuid NOT NULL REFERENCES league_seasons(id),
  member_id               uuid NOT NULL REFERENCES league_members(id),
  player_id               uuid NOT NULL REFERENCES players(id),   -- player being claimed
  drop_player_id          uuid REFERENCES players(id),            -- player being dropped (NULL if roster room exists)
  priority_at_submission  int NOT NULL,
  status                  waiver_claim_status NOT NULL DEFAULT 'pending',
  submitted_at            timestamptz NOT NULL DEFAULT now(),
  process_date            date NOT NULL,                          -- which daily run processes this
  processed_at            timestamptz,
  failure_reason          text
);
```

---

### waiver_wire_log

Log of when players are placed on waivers and when they clear to free agency.

```sql
CREATE TABLE waiver_wire_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id      uuid NOT NULL REFERENCES league_seasons(id),
  player_id             uuid NOT NULL REFERENCES players(id),
  dropped_by_member_id  uuid REFERENCES league_members(id),
  placed_on_waivers_at  timestamptz NOT NULL DEFAULT now(),
  clears_at             timestamptz NOT NULL,                     -- placed_at + 48 hours
  cleared_at            timestamptz,                              -- set when actually cleared
  claimed_by_claim_id   uuid REFERENCES waiver_claims(id)
);
```

---

### trades

Header record for a trade proposal. 2-team only.

```sql
CREATE TABLE trades (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id               uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id        uuid NOT NULL REFERENCES league_seasons(id),
  proposer_member_id      uuid NOT NULL REFERENCES league_members(id),
  recipient_member_id     uuid NOT NULL REFERENCES league_members(id),
  status                  trade_status NOT NULL DEFAULT 'pending',
  notes                   text,
  proposed_at             timestamptz NOT NULL DEFAULT now(),
  accepted_at             timestamptz,
  veto_window_expires_at  timestamptz,                           -- accepted_at + 24 hours
  completed_at            timestamptz,
  vetoed_at               timestamptz,

  CHECK (proposer_member_id <> recipient_member_id)
);
```

---

### trade_items

Line items within a trade. Each row is one asset (player or pick) moving between sides.

```sql
CREATE TABLE trade_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id    uuid NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  side        trade_side NOT NULL,               -- which side is GIVING this asset
  player_id   uuid REFERENCES players(id),       -- NULL if pick
  pick_id     uuid REFERENCES draft_picks(id),   -- NULL if player
  created_at  timestamptz NOT NULL DEFAULT now(),

  CHECK (
    (player_id IS NOT NULL AND pick_id IS NULL) OR
    (player_id IS NULL AND pick_id IS NOT NULL)
  )
);
```

---

### trade_vetos

Records individual veto actions within the 24-hour window.

```sql
CREATE TABLE trade_vetos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id    uuid NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES league_members(id),
  veto_type   veto_type NOT NULL,
  vetoed_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (trade_id, member_id)
);
```

---

### roster_transactions

Append-only audit log of all roster moves.

```sql
CREATE TABLE roster_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_season_id      uuid NOT NULL REFERENCES league_seasons(id),
  member_id             uuid NOT NULL REFERENCES league_members(id),
  player_id             uuid NOT NULL REFERENCES players(id),
  transaction_type      text NOT NULL,
  -- 'draft_won', 'waiver_add', 'waiver_drop', 'fa_add', 'fa_drop',
  -- 'trade_in', 'trade_out', 'ir_designate', 'ir_return'
  related_trade_id      uuid REFERENCES trades(id),
  related_claim_id      uuid REFERENCES waiver_claims(id),
  related_nomination_id uuid REFERENCES nominations(id),
  occurred_at           timestamptz NOT NULL DEFAULT now()
);
```

---

## Indexes

```sql
-- profiles
CREATE INDEX idx_profiles_username ON profiles(username);

-- leagues
CREATE INDEX idx_leagues_commissioner ON leagues(commissioner_id);
CREATE INDEX idx_leagues_status ON leagues(status);
CREATE INDEX idx_leagues_invite_code ON leagues(invite_code);

-- league_members
CREATE INDEX idx_league_members_user ON league_members(user_id);
CREATE INDEX idx_league_members_league ON league_members(league_id);

-- players
CREATE INDEX idx_players_sportsdata_id ON players(sportsdata_id);
CREATE INDEX idx_players_display_name ON players(display_name);
CREATE INDEX idx_players_nba_team ON players(nba_team);
CREATE INDEX idx_players_position ON players(position);
CREATE INDEX idx_players_dynasty_rank ON players(dynasty_rank) WHERE dynasty_rank IS NOT NULL;

-- roster_players
CREATE INDEX idx_roster_players_member ON roster_players(member_id);
CREATE INDEX idx_roster_players_league_season ON roster_players(league_id, league_season_id);
CREATE INDEX idx_roster_players_player ON roster_players(player_id);

-- player_game_stats
CREATE INDEX idx_pgs_player_week ON player_game_stats(player_id, week_number, season_year);
CREATE INDEX idx_pgs_game ON player_game_stats(game_id);
CREATE INDEX idx_pgs_season_week ON player_game_stats(season_year, week_number);

-- nba_games
CREATE INDEX idx_nba_games_date ON nba_games(game_date);
CREATE INDEX idx_nba_games_season_week ON nba_games(season_year, week_number);

-- weekly_lineups
CREATE INDEX idx_lineups_member_week ON weekly_lineups(member_id, league_season_id, week_number);
CREATE INDEX idx_lineups_league_week ON weekly_lineups(league_id, league_season_id, week_number);

-- matchups
CREATE INDEX idx_matchups_league_season_week ON matchups(league_id, league_season_id, week_number);
CREATE INDEX idx_matchups_home ON matchups(home_member_id);
CREATE INDEX idx_matchups_away ON matchups(away_member_id);

-- standings
CREATE INDEX idx_standings_league_season_week ON standings(league_id, league_season_id, week_number);
CREATE INDEX idx_standings_member ON standings(member_id);

-- nominations
CREATE INDEX idx_nominations_draft ON nominations(draft_id);
CREATE INDEX idx_nominations_draft_status ON nominations(draft_id, status);

-- bids
CREATE INDEX idx_bids_nomination ON bids(nomination_id);
CREATE INDEX idx_bids_member ON bids(member_id);

-- draft_picks
CREATE INDEX idx_draft_picks_league_year ON draft_picks(league_id, season_year);
CREATE INDEX idx_draft_picks_current_owner ON draft_picks(current_owner_id);

-- waiver_claims
CREATE INDEX idx_waiver_claims_process_date ON waiver_claims(process_date, status);
CREATE INDEX idx_waiver_claims_member ON waiver_claims(member_id);
CREATE INDEX idx_waiver_claims_player ON waiver_claims(player_id);

-- waiver_wire_log
CREATE INDEX idx_waiver_log_league_player ON waiver_wire_log(league_id, player_id);
CREATE INDEX idx_waiver_log_clears_at ON waiver_wire_log(clears_at) WHERE cleared_at IS NULL;

-- trades
CREATE INDEX idx_trades_league ON trades(league_id);
CREATE INDEX idx_trades_proposer ON trades(proposer_member_id);
CREATE INDEX idx_trades_recipient ON trades(recipient_member_id);
CREATE INDEX idx_trades_status ON trades(league_id, status);

-- trade_items
CREATE INDEX idx_trade_items_trade ON trade_items(trade_id);

-- roster_transactions
CREATE INDEX idx_transactions_league_season ON roster_transactions(league_id, league_season_id);
CREATE INDEX idx_transactions_member ON roster_transactions(member_id);
CREATE INDEX idx_transactions_occurred_at ON roster_transactions(occurred_at DESC);

-- player_projections
CREATE INDEX idx_projections_player_week ON player_projections(player_id, season_year, week_number);
```

---

## Deferred / Future

- `fantasy_score_cache` — per league per player per game, for query performance
- `weekly_lineup_history` — audit trail of mid-week lineup changes
- In-app chat / message threads
- Taxi squad / farm system

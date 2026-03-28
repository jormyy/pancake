# Dynasty Fantasy Basketball App — Roadmap

## Phase 1 — Foundation

### 1. Project Setup

- [x] Initialize Expo project (TypeScript template)
- [x] Set up folder structure (`/app`, `/components`, `/lib`, `/hooks`, `/types`)
- [x] Configure ESLint + Prettier
- [x] Set up Supabase project, get API keys
- [x] Set up Railway project for Node.js backend
- [x] Connect Expo app to Supabase client
- [x] Configure environment variables (`.env`)

### 2. Auth

- [x] Email/password sign up and log in via Supabase Auth
- [x] Session persistence (stay logged in on app reopen)
- [x] Profile creation on first sign up (username, display name)
- [x] Log out
- [x] Auth guard — redirect unauthenticated users from protected screens

### 3. Database Schema

- [x] Write and run initial migration: all tables from `SCHEMA.md`
- [x] Write and run indexes migration
- [x] Seed default `lineup_slot_templates` values
- [x] Seed default `scoring_settings` JSON template
- [x] Verify schema in Supabase dashboard

### 4. NBA Data Integration (NBA CDN + Sleeper API)

- [x] Pull and store NBA player list (sync to `players` table)
- [x] Pull current season game schedule (sync to `nba_games` + `season_weeks`)
- [x] Pull player box scores per game (sync to `player_game_stats`)
- [x] Pull weekly projections (computed from rolling averages)
- [x] Set up cron jobs on Railway to sync stats daily

## Phase 2 — League Core

- [x] Create/join a league
- [x] Commissioner settings (scoring customization, playoff week, veto rules)
- [x] Roster management (view roster, IR slots)
- [x] Player search and profiles (stats, projections)

## Phase 3 — Draft

- [x] Auction draft room (real-time via Supabase Realtime)
- [x] Nomination flow, bidding, 30-second countdown
- [x] Budget tracking, roster filling
- [x] Post-draft roster lock

## Phase 4 — Season Gameplay

- [x] Weekly lineup setting (manual + auto-set)
- [x] Live scoring
- [x] Waiver wire (priority system, 2-day free agency delay)
- [x] Trade system (offer, accept, veto window, pick trading)
- [x] H2H matchup generation and weekly results

## Phase 5 — Standings & Playoffs

- [x] Standings page with all tiebreakers
- [x] Playoff bracket generation
- [x] Playoff matchups and results

## Phase 6 — Annual Cycle

- [x] Rookie draft
- [x] Season reset flow
- [x] Pick bank management (future picks across years)

## Phase 7 — Polish & Launch

- [ ] UI/UX pass
- [x] Push notifications
- [ ] Monetization implementation
- [ ] App Store submission

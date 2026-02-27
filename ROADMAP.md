# Dynasty Fantasy Basketball App — Roadmap

## Phase 1 — Foundation

### 1. Project Setup

- [ ] Initialize Expo project (TypeScript template)
- [ ] Set up folder structure (`/app`, `/components`, `/lib`, `/hooks`, `/types`)
- [ ] Configure ESLint + Prettier
- [ ] Set up Supabase project, get API keys
- [ ] Set up Railway project for Node.js backend
- [ ] Connect Expo app to Supabase client
- [ ] Configure environment variables (`.env`)

### 2. Auth

- [ ] Email/password sign up and log in via Supabase Auth
- [ ] Session persistence (stay logged in on app reopen)
- [ ] Profile creation on first sign up (username, display name)
- [ ] Log out
- [ ] Auth guard — redirect unauthenticated users from protected screens

### 3. Database Schema

- [ ] Write and run initial migration: all tables from `SCHEMA.md`
- [ ] Write and run indexes migration
- [ ] Seed default `lineup_slot_templates` values
- [ ] Seed default `scoring_settings` JSON template
- [ ] Verify schema in Supabase dashboard

### 4. SportsData.io Integration

- [ ] Register for SportsData.io API access
- [ ] Pull and store NBA player list (sync to `players` table)
- [ ] Pull current season game schedule (sync to `nba_games` + `season_weeks`)
- [ ] Pull player box scores per game (sync to `player_game_stats`)
- [ ] Pull weekly projections (sync to `player_projections`)
- [ ] Set up cron job on Railway to sync stats daily

## Phase 2 — League Core

- [ ] Create/join a league
- [ ] Commissioner settings (scoring customization, playoff week, veto rules)
- [ ] Roster management (view roster, IR slots)
- [ ] Player search and profiles (stats, projections)

## Phase 3 — Draft

- [ ] Auction draft room (real-time via Supabase Realtime/Socket.io)
- [ ] Nomination flow, bidding, 30-second countdown
- [ ] Budget tracking, roster filling
- [ ] Post-draft roster lock

## Phase 4 — Season Gameplay

- [ ] Weekly lineup setting (manual + auto-set)
- [ ] Live scoring (pull stats from SportsData.io)
- [ ] Waiver wire (priority system, 2-day free agency delay)
- [ ] Trade system (offer, accept, veto window, pick trading)
- [ ] H2H matchup generation and weekly results

## Phase 5 — Standings & Playoffs

- [ ] Standings page with all tiebreakers
- [ ] Playoff bracket generation
- [ ] Playoff matchups and results

## Phase 6 — Annual Cycle

- [ ] Rookie draft
- [ ] Season reset flow
- [ ] Pick bank management (future picks across years)

## Phase 7 — Polish & Launch

- [ ] UI/UX pass
- [ ] Push notifications
- [ ] Monetization implementation
- [ ] App Store submission

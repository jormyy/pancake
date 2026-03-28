# Pancake - Dynasty Fantasy Basketball App

A dynasty fantasy basketball app targeting the gap between ESPN (no dynasty support) and Fantrax/Sleeper (poor UX or flawed scoring). Built for managers with busy lifestyles who want meaningful, skill-rewarding gameplay.

## Tech Stack

- **Frontend**: Expo / React Native (TypeScript)
- **Backend**: Node.js / Fastify API server with cron jobs
- **Database**: PostgreSQL via Supabase
- **Auth**: Supabase Auth
- **Real-time**: Supabase Realtime
- **Data Sources**: NBA CDN (schedules/scores) + Sleeper API (players/projections)
- **Hosting**: Supabase (DB/auth) + Railway (API)

## Getting Started

### Frontend

```bash
npm install
npx expo start
```

### Backend

```bash
cd backend
npm install
npm run dev
```

### Environment

Copy `.env.example` to `.env` and fill in values for Supabase URL, anon key, and any other required secrets.

## Project Structure

```
app/          # Expo Router screens (auth, tabs, modals)
backend/      # Node.js/Fastify API server + cron jobs
  src/
    routes/   # Fastify route plugins
    sync/     # Data sync modules
    cron/     # Cron job registration
    lib/      # Shared libraries + utils
    plugins/  # Fastify plugins
    schemas/  # Request validation schemas
lib/          # Frontend data layer
  shared/     # Deduplicated utilities
hooks/        # React hooks
components/   # Reusable UI components
constants/    # App constants
types/        # TypeScript type definitions
contexts/     # React context providers
supabase/     # Database migrations
```

## Key Features

- **Auction draft** with real-time bidding via Supabase Realtime
- **Snake rookie draft** for annual offseason drafts
- **Daily lineups** with manual and auto-set options
- **Waiver wire** with priority-based claiming
- **Trades** with players and future draft picks, 24-hour veto window
- **H2H matchups** with cumulative weekly scoring
- **Playoff bracket** generation and results
- **Push notifications** via Expo

## Documentation

- [SPEC.md](./SPEC.md) -- Full app specification and rules
- [SCHEMA.md](./SCHEMA.md) -- Database schema reference
- [ROADMAP.md](./ROADMAP.md) -- Development roadmap and progress

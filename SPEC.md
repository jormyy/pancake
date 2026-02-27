# Dynasty Fantasy Basketball App — Spec

## Overview
An iOS dynasty fantasy basketball app targeting the gap between ESPN (no dynasty support) and Fantrax/Sleeper (poor UX or flawed scoring systems). Built for managers with busy lifestyles who still want meaningful, skill-rewarding gameplay.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Mobile | React Native (Expo) |
| Backend | Node.js (Express or Fastify) |
| Database | PostgreSQL via Supabase |
| Auth | Supabase Auth |
| Real-time | Supabase Realtime or Socket.io |
| Stats + Projections | SportsData.io |
| Hosting | Supabase (DB/auth) + Railway (API) |

---

## League Structure

- Variable team count per league
- 20 active roster slots + 2 IR slots = 22 total per manager
- No taxi squad (tabled for later)
- Points-based scoring
  - Default scoring template (ESPN-style)
  - Commissioners can customize slot counts (number of PG, UTIL, bench slots, etc.) with a sensible default
  - Commissioners can add/customize scoring categories (e.g. triple-double bonus)

---

## Draft

- **Format**: Auction draft (initial dynasty draft); Snake draft (annual rookie draft)
- **Budget**: Equal starting budget for all managers
- **Nomination order**: Based on scraped dynasty rankings
- **Bidding**: eBay-style — 30-second countdown resets with each new bid
- **Minimum bid**: $1
- **No-bid**: If a nominated player gets zero bids, they become a free agent immediately
- **End condition**: All rosters full OR all managers out of money (whichever comes first)

---

## Scoring & Lineup

- **Scoring**: Cumulative weekly points — all games played in the week count
- **Lineup cadence**: Set weekly, mid-week changes allowed at any point
- **Auto-set**: Available at any point in the week, uses SportsData.io projections
- **Manual set**: Full manual control if desired

---

## Waiver Wire

- Priority waivers (reverse standings order)
- Claiming a player moves you to the back of the line — no resets
- Dropped players enter free agency after 2 days

---

## Trades

- **Picks**: Future picks only, up to 5 years in advance
- **Deadline**: NBA trade deadline + 2 weeks
- **Veto window**: 24 hours
- **Veto rules**: Trade is killed if:
  - Commissioner vetoes, OR
  - 50%+ of remaining league members veto

---

## Standings

- Head-to-head matchups
- **Tiebreakers (in order)**:
  1. Points fielded (total season points scored)
  2. Max possible points fielded (best lineup you could have set using your actual roster, computed post-week)
  3. Points against
  4. Rock paper scissors — in-app mini-game between tied managers (ties re-challenge)

---

## Playoffs

- **<10 teams**: Top 4 qualify — seeds 1v4, 2v3 → championship
- **10+ teams**: Top 6 qualify — seeds 1 & 2 get bye, 3v6 and 4v5 in round 1 → semis → championship
- **Start**: Week 20 (commissioner can adjust ±2 weeks)
- **End**: Concludes with NBA regular season end

---

## Rookie Draft

- Annual draft held before the start of each new season
- Format: TBD

---

## Monetization

- TBD — likely commissioner-pays model given Fantrax is free competition

---

## Tabled / Future Features

- Taxi squad / farm system
- Push notifications
- In-app chat / trash talk
- Commissioner tools UI
- Historical league records
- Android support

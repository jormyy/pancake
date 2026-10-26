# Architecture

Pancake separates browser presentation, shared calculations, and database rules. This document maps those boundaries and the data flow between them.

## Code map

| Concern | Source | Contract |
| --- | --- | --- |
| Screens and navigation | `app/`, `components/`, `hooks/` | Expo Router and web components |
| Public startup | `constants/boot-shell.ts`, `app/+html.tsx`, `public/sw.js` | [PWA and loading](pwa-live-data.md) |
| Client data | `lib/` | Auth, PostgREST, RPCs, Edge API, and Realtime |
| Edge API | `supabase/functions/api/` | [Backend boundaries](supabase-backend-route-inventory.md) |
| Database rules | `supabase/sql/functions/by-name/` | Canonical function sources |
| Published schema | `supabase/migrations/` | Immutable ordered migrations |
| Shared rules | `core/`, `supabase/shared-src/` | Generated app, Edge, and SQL copies |

Run `npm run check:edge-shared`, `npm run check:core-cjs`, and `npm run check:db-function-sources` to check source parity.

## Auth and saved content

The boot shell reads the configured project's session and logout markers before showing saved identity.
An expired token does not authorize data reads.
Online restoration waits for refresh while the page is visible.
Membership reads confirm the saved league choice before actions become available.
Sign-out and account changes clear private caches and fence late responses.

Saved screen content helps startup and route returns.
It does not establish membership, locks, eligibility, or write permission.
Each loader owns its freshness and refresh rules.

## Change hints

`lib/league-changes.ts` shares one authenticated stream for the selected league.
Topics cover lineups, rosters, scores, games, stats, inventory, and resources.
Hints contain scope keys and revisions, not player rows or box scores.
Clients read authoritative data after a change.
Missing revisions, malformed details, overflow, and reconnects require broader reads.
Hidden or offline consumers retain pending work until they can read again.

Inventory hints cover picks, claims, waiver entries, priority, FAAB, and season changes.
Resource hints cover averages, projections, and scoring settings.
Live stats read displayed players and keep a safety poll.
The live fallback polls more often when the hint stream disconnects.

## League rules

Lineups distinguish starters from bench players. IR and taxi have separate capacity limits.
Auto-set daily starts enabled for new teams. Later seasons preserve the manager's choice.
See [lineup automation](pre-tipoff-lineups.md).

Commissioners can configure team limits, playoff entrants, and each playoff round's week length.
Configured brackets use seeded elimination with first-round byes for top seeds.
Odd-team leagues receive regular-season byes.
Skipped regular weeks retain marked history and do not affect standings.
See [roster, trade, and season rules](roster-lifecycle.md).

The public activity feed shows completed transactions and announcements, without pending trade offers or trade-block changes.
Private offers remain in Trades.
Commissioner announcements appear in a dismissible Home banner and League > Activity.
Home shows the newest announcement from another member in the last 14 days.
It must be newer than the last dismissed announcement.
Announcements that arrive while Home stays open appear on pull, retry, or return.
Dismissal applies to that manager and league on the current device.
Dismissal leaves the Activity entry available.
Announcement reads preserve cached Home content and visible errors without layout shifts or flicker.

## Season transitions

The season-boundary worker creates playoffs after the regular season finishes.
Advancement waits for final results and the stat-correction grace period.
Consumed rounds stay frozen.
Rollover preserves history, resets season balances, and prepares the rookie draft and new schedule.
An unrun rookie draft has a best-available fallback before the new season activates.
Invalid calendars remain errors. An unpublished next calendar causes a retry.

The [historical simulator](season-simulator.md) exercises ingestion and season transitions.
The [verification guide](verification.md) lists the focused database checks.

## Claims and trade decisions

Every available player enters through a scheduled FAAB claim.
The database freezes claim changes at the daily cutoff and settles ownership, drops, balances, and priority together.
Trade plans reserve assets and capacity across all accepted trades.
Settlement checks resulting rosters before applying every transfer and retained-player move in one transaction.
[Roster lifecycle](roster-lifecycle.md) owns those rules.

The Edge API computes trade estimates from database-owned league inputs and shared dynasty calculations.
Offer submission attaches the frozen quote in the same transaction.
Historical revaluation reads saved routes with current inputs and leaves the original quote unchanged.
[Trade estimates](trade-estimates.md) owns quote expiry, authorization, and saved views.

The `matchup-forecast` Edge worker computes shared forecasts outside screen loads.
Database triggers queue changed inputs, and revision tokens reject obsolete results.
Clients read member-authorized cached forecasts and show coverage and stale state.
[Matchup forecasts](matchup-forecasts.md) owns model limits and publication locks.

## Projection data

`get_league_projection_rows` supplies player views, lineup optimization, and matchup forecasts.
Sleeper sync selects the scoring week containing today's Pacific date.
A day outside every scoring week records a successful skip without fetching or changing projections.
[Source monitoring](source-monitoring.md#projection-readers) owns provider precedence, freshness, and storage rules.
[PWA behavior](pwa-live-data.md#player-detail) owns the player detail layout.

## Scheduled work

Cron calls guarded database dispatch functions through pg_net.
Workers record outcomes in sync records; reconciliation compares those outcomes with transport responses.
Due-work gates skip idle calls. Leases and receipt tokens fence retries.
See [source monitoring](source-monitoring.md) for schedules, retries, and retention.

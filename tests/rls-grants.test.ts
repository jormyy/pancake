import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Persistence-layer IDOR guard.
//
// These SECURITY DEFINER RPCs mutate gameplay state and DO NOT verify auth.uid()
// — they trust a caller-supplied member_id/league_id. That is safe ONLY because
// they are granted to `service_role` alone and reached exclusively through the
// backend, which re-derives the member from the authenticated JWT. If any were
// ever GRANTed EXECUTE to `authenticated`/`anon`, they become instant
// cross-team takeover primitives (steal players, forge bids/waivers/vetoes,
// toggle another team's IR, advance seasons).
//
// This test fails the build if any migration grants one of them to a client
// role — the exact mistake a future "make this feature work from the client"
// change would introduce.

const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations')

const SERVICE_ROLE_ONLY_RPCS = [
    'propose_trade_atomic',
    'accept_trade_atomic',
    'complete_accepted_trade_atomic',
    'veto_trade_atomic',
    'expire_trade_completion_failure_atomic',
    'create_waiver_claim_atomic',
    'cancel_waiver_claim_atomic',
    'process_next_waiver_claim_atomic',
    'place_auction_bid_atomic',
    'close_auction_nomination_atomic',
    'withdraw_auction_nomination_atomic',
    'make_snake_pick_atomic',
    'start_rookie_draft_atomic',
    'reseed_rookie_draft_picks_atomic',
    'advance_season_atomic',
    'toggle_ir_atomic',
    'toggle_taxi_atomic',
    'expire_waiver_wire_logs',
    'clear_ineligible_taxi_players',
    'try_live_poll_lease',
    'release_live_poll_lease',
    'invoke_edge_function',
    'merge_players',
    'merge_duplicate_players',
    'count_final_games_missing_stats',
]

const allMigrationSql = (): string =>
    readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'))
        .join('\n')

describe('service-role-only RPCs are never granted to client roles', () => {
    const sql = allMigrationSql()

    it.each(SERVICE_ROLE_ONLY_RPCS)('%s is not GRANTed EXECUTE to authenticated/anon', (fn) => {
        const grants = [
            ...sql.matchAll(
                new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)\\s+TO\\s+([^;]+);`, 'gi'),
            ),
        ]
        for (const match of grants) {
            const grantees = match[1].toLowerCase()
            expect(grantees, `${fn} granted to a client role: "${match[1].trim()}"`).not.toMatch(
                /\b(authenticated|anon|public)\b/,
            )
        }
    })

    it('every service-role-only RPC is explicitly granted to service_role somewhere', () => {
        for (const fn of SERVICE_ROLE_ONLY_RPCS) {
            const granted = new RegExp(
                `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)\\s+TO\\s+[^;]*\\bservice_role\\b`,
                'i',
            ).test(sql)
            expect(granted, `${fn} is never granted to service_role`).toBe(true)
        }
    })
})

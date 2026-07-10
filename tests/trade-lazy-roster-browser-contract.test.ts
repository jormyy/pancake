import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8')

describe('Sleeper lazy roster-limit contracts', () => {
    it('accepts trades without a browser-side drop workflow', () => {
        const screen = read('app/(tabs)/trades.tsx')
        const hook = read('hooks/use-trade-actions.ts')
        const client = read('lib/trades.ts')
        const api = read('supabase/functions/api/trades.ts')

        expect(screen).not.toContain('DropPlayerPickerModal')
        expect(hook).not.toMatch(/getRoster|dropPicker|selectDrop|rosterSize/)
        expect(client).toContain("apiPost(`/trades/${tradeId}/accept`, { memberId })")
        expect(client).not.toContain('dropRosterPlayerIds')
        expect(api).not.toContain('p_drop_roster_player_ids')
    })

    it('keeps the cap out of trade settlement and enforces it at lineup entrypoints', () => {
        const acceptance = read('supabase/sql/functions/by-name/private/accept_trade_participant_atomic.sql')
        const completion = read('supabase/sql/functions/by-name/public/complete_accepted_trade_atomic.sql')
        const lineupMoves = read('supabase/sql/functions/by-name/public/set_player_slot_moves_atomic.sql')
        const autoLineup = read('supabase/sql/functions/by-name/public/auto_set_lineup_atomic.sql')
        const capGuard = read('supabase/sql/functions/by-name/private/assert_roster_within_active_limit.sql')
        const routeGuards = [
            'private/prevent_accepted_trade_asset_roster_delete.sql',
            'private/prevent_accepted_or_inactive_roster_move.sql',
            'private/prevent_conflicting_or_inactive_trade_accept.sql',
            'private/validate_waiver_claim_drop_player.sql',
            'public/drop_player_atomic.sql',
            'public/toggle_ir_atomic.sql',
            'public/toggle_taxi_atomic.sql',
        ].map((file) => read(`supabase/sql/functions/by-name/${file}`)).join('\n')
        const computePoints = read('supabase/sql/functions/by-name/public/compute_fantasy_points.sql')
        const finalizeWeek = read('supabase/sql/functions/by-name/public/finalize_score_week_atomic.sql')

        expect(acceptance).not.toMatch(/drop_roster|trade_drop_reservations|required_drops|roster_size/)
        expect(completion).not.toMatch(/trade_drop_reservations|overfill a roster|roster_size/)
        expect(lineupMoves).toContain('private.assert_roster_within_active_limit')
        expect(autoLineup).toContain('private.assert_roster_within_active_limit')
        expect(capGuard).toContain('v_active_count > v_roster_size')
        expect(capGuard).toContain('over the active player limit')
        expect(computePoints).not.toMatch(/roster_size|assert_roster_within_active_limit/)
        expect(finalizeWeek).not.toMatch(/roster_size|assert_roster_within_active_limit/)
        expect(routeGuards).not.toMatch(/COALESCE\s*\(\s*(?:item|ti|other_item)\.from_member_id/i)
        expect(routeGuards).not.toMatch(/CASE\s+WHEN\s+(?:item|ti|other_item)\.side/i)
    })

    it('removes the obsolete reservation schema while retaining accepted-asset guards', () => {
        const migration = read('supabase/migrations/20260709100027_sleeper_lazy_roster_limits.sql')
        const deleteGuard = read('supabase/sql/functions/by-name/private/prevent_accepted_trade_asset_roster_delete.sql')
        const moveGuard = read('supabase/sql/functions/by-name/private/prevent_accepted_or_inactive_roster_move.sql')

        expect(migration).toContain('DROP TABLE public.trade_drop_reservations')
        expect(deleteGuard).toContain("trade.status = 'accepted'::trade_status")
        expect(moveGuard).toContain("trade.status = 'accepted'::trade_status")
        expect(moveGuard).toContain('Inactive roster players must be activated before they can be traded.')
    })
})

import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, read } from './source-guard'

describe('configurable trade veto settings', () => {
    it('persists veto config through league settings and generated types', () => {
        const migration = read('supabase/migrations/20260708000003_trade_veto_configuration.sql')
        const league = read('lib/league.ts')
        const appTypes = read('types/app.ts')
        const databaseTypes = read('types/database.ts')
        const settings = latestFunctionDefinition('update_league_settings_atomic')

        expect(migration).toContain('ADD COLUMN IF NOT EXISTS trade_veto_mode text NOT NULL DEFAULT')
        expect(migration).toContain("CHECK (trade_veto_mode IN ('disabled', 'commissioner', 'member_vote'))")
        expect(migration).toContain('CHECK (trade_veto_window_hours BETWEEN 0 AND 168)')
        expect(migration).toContain('CHECK (trade_veto_threshold_percent BETWEEN 1 AND 100)')
        expect(league).toContain("export type TradeVetoMode = 'disabled' | 'commissioner' | 'member_vote'")
        expect(league).toContain('trade_veto_mode,')
        expect(league).toContain('payload.trade_veto_window_hours')
        expect(appTypes).toContain('trade_veto_mode?: TradeVetoMode')
        expect(databaseTypes).toContain('trade_veto_threshold_percent: number')
        expect(settings).toContain("v_trade_veto_mode NOT IN ('disabled', 'commissioner', 'member_vote')")
        expect(settings).toContain('trade_veto_window_hours = COALESCE(v_trade_veto_window_hours, trade_veto_window_hours)')
        expect(settings).toContain('trade_veto_threshold_percent = COALESCE(v_trade_veto_threshold_percent, trade_veto_threshold_percent)')
    })

    it('drives accept and veto behavior from league veto config', () => {
        const acceptTrade = latestFunctionDefinition('accept_trade_atomic')
        const vetoTrade = latestFunctionDefinition('veto_trade_atomic')
        const api = read('supabase/functions/api/trades.ts')

        expect(acceptTrade).toContain("COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled'")
        expect(acceptTrade).toContain('veto_window_expires_at = now() + make_interval(hours => v_veto_window_hours)')
        expect(acceptTrade).toContain('PERFORM public.complete_accepted_trade_atomic(p_trade_id)')
        expect(acceptTrade).not.toContain("veto_window_expires_at = now() + INTERVAL '24 hours'")

        expect(vetoTrade).toContain('Trade vetoes are disabled for this league.')
        expect(vetoTrade).toContain('Only commissioners can veto trades in this league.')
        expect(vetoTrade).toContain('COALESCE(v_league.trade_veto_threshold_percent, 50)')
        expect(vetoTrade).toContain('member.id <> v_trade.proposer_member_id')
        expect(vetoTrade).toContain('member.id <> v_trade.recipient_member_id')
        expect(vetoTrade).toContain('participant.member_id = member.id')
        expect(vetoTrade).toContain('IF v_is_trade_party THEN')
        expect(vetoTrade).not.toContain('v_is_trade_party AND NOT v_is_commissioner')
        expect(vetoTrade).toContain("COALESCE(v_league.trade_veto_mode, 'member_vote') = 'commissioner'")
        expect(vetoTrade).not.toContain('CEIL(COALESCE(v_eligible_count, 0)::numeric / 2)')

        expect(api).toContain('Completion will follow your league veto settings.')
        expect(api).not.toContain('The 24-hour veto window has opened')
    })

    it('surfaces veto controls and matches trade-card affordances to settings', () => {
        const settings = read('app/(modals)/commissioner-settings.tsx')
        const tradesScreen = read('app/(tabs)/trades.tsx')
        const tradeCard = read('components/trades/TradeCard.tsx')

        expect(settings).toContain('TRADE VETO')
        expect(settings).toContain('tradeVetoModeDescription')
        expect(settings).toContain('Veto Window Hours')
        expect(settings).toContain('Member Threshold %')
        expect(settings).toContain("setTradeVetoMode(mode.value)")
        expect(settings).toContain("showAlert('Invalid', 'Member veto threshold must be between 1% and 100%.')")

        expect(tradesScreen).toContain("tradeVetoMode={currentLeague?.trade_veto_mode ?? 'member_vote'}")
        expect(tradesScreen).toContain('isCommissioner={isCommissioner}')
        expect(tradeCard).toContain("tradeVetoMode === 'member_vote'")
        expect(tradeCard).toContain("tradeVetoMode === 'commissioner' && isCommissioner")
        expect(tradeCard).toContain('canVetoBySettings')
    })
})

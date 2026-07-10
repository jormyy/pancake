import { describe, expect, it } from 'vitest'
import {
    EMPTY_COMMISSIONER_SETTINGS_DRAFT,
    buildCommissionerSettingsChange,
    commissionerHydrationDecision,
    tradeVetoModeFromValue,
    waiverModeFromValue,
    type CommissionerSettingsDraft,
} from '@/lib/commissioner-settings-draft'

function draft(overrides: Partial<CommissionerSettingsDraft> = {}): CommissionerSettingsDraft {
    return {
        ...EMPTY_COMMISSIONER_SETTINGS_DRAFT,
        scoring: { points: '1' },
        slots: { PG: 1 },
        rosterSize: '20',
        irSlots: '2',
        taxiSlots: '0',
        auctionBudget: '200',
        playoffWeek: '20',
        weeklyAddLimit: '0',
        faabBudget: '100',
        tradeVetoWindowHours: '24',
        tradeVetoThresholdPercent: '50',
        ...overrides,
    }
}

describe('commissioner settings draft', () => {
    it('normalizes persisted option strings without casts', () => {
        expect(waiverModeFromValue('rolling')).toBe('rolling')
        expect(waiverModeFromValue('unknown')).toBe('faab')
        expect(tradeVetoModeFromValue('commissioner')).toBe('commissioner')
        expect(tradeVetoModeFromValue('unknown')).toBe('member_vote')
    })

    it('validates settings and emits only changed fields', () => {
        const baseline = draft()
        const changed = draft({ weeklyAddLimit: '4', tradeVetoMode: 'disabled', tradeVetoWindowHours: '0' })
        const result = buildCommissionerSettingsChange(changed, baseline, 'active', ['points'], ['PG'])

        expect(result).toEqual({
            updates: {
                weekly_add_unlimited: false,
                weekly_add_limit: 4,
                trade_veto_mode: 'disabled',
                trade_veto_window_hours: 0,
            },
            slotsChanged: false,
            slotUpdates: null,
        })
    })

    it('rejects invalid values and lineup changes outside setup', () => {
        const baseline = draft()
        expect(buildCommissionerSettingsChange(
            draft({ playoffWeek: '30' }), baseline, 'setup', ['points'], ['PG'],
        )).toEqual({ error: 'Playoff start week must be between 18 and 24.' })
        expect(buildCommissionerSettingsChange(
            draft({ slots: { PG: 2 } }), baseline, 'active', ['points'], ['PG'],
        )).toEqual({ error: 'Lineup slots can only be changed during league setup.' })
    })

    it('rejects partial integers and malformed decimals instead of truncating or zeroing them', () => {
        const baseline = draft()
        expect(buildCommissionerSettingsChange(
            draft({ rosterSize: '20.5' }), baseline, 'setup', ['points'], ['PG'],
        )).toEqual({ error: 'Roster size must be at least 1.' })
        expect(buildCommissionerSettingsChange(
            draft({ scoring: { points: '1.5points' } }), baseline, 'setup', ['points'], ['PG'],
        )).toEqual({ error: 'Scoring value for points must be a valid number.' })
        expect(buildCommissionerSettingsChange(
            draft({ scoring: { points: '-1.25' } }), baseline, 'setup', ['points'], ['PG'],
        )).toMatchObject({ updates: { scoring_settings: { points: -1.25 } } })
    })

    it('preserves same-league edits and only conflicts on a changed remote baseline', () => {
        const baseline = draft()
        const local = draft({ rosterSize: '21' })
        expect(commissionerHydrationDecision({
            incomingLeagueId: 'league-a', hydratedLeagueId: 'league-a', draft: local,
            baseline, remote: draft(), force: false,
        })).toBe('preserve')
        expect(commissionerHydrationDecision({
            incomingLeagueId: 'league-a', hydratedLeagueId: 'league-a', draft: local,
            baseline, remote: draft({ irSlots: '3' }), force: false,
        })).toBe('conflict')
        expect(commissionerHydrationDecision({
            incomingLeagueId: 'league-b', hydratedLeagueId: 'league-a', draft: local,
            baseline, remote: draft({ irSlots: '3' }), force: false,
        })).toBe('hydrate')
    })
})

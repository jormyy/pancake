import { describe, expect, it } from 'vitest'
import {
    EMPTY_COMMISSIONER_SETTINGS_DRAFT,
    buildCommissionerSettingsChange,
    commissionerHydrationDecision,
    tradeDeadlineDraftValue,
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
        playoffTotalWeeks: '2',
        playoffRoundWeeks: ['1', '1'],
        weeklyAddLimit: '0',
        faabBudget: '100',
        tradeVetoWindowHours: '24',
        tradeVetoThresholdPercent: '50',
        ...overrides,
    }
}

describe('commissioner settings draft', () => {
    it('accepts large leagues and a six-round asymmetric plan without a product cap', () => {
        const baseline = draft({ teamLimit: '10', playoffEntrants: '4', playoffRoundCount: '2' })
        const changed = draft({ teamLimit: '1001', playoffEntrants: '33', playoffRoundCount: '6', playoffRoundWeeks: ['1', '2', '1', '1', '2', '1'] })
        const result = buildCommissionerSettingsChange(changed, baseline, 'setup', ['points'], ['PG'])
        expect(result).toMatchObject({ updates: { team_limit: 1001, playoff_entrants: 33, playoff_round_lengths: [1, 2, 1, 1, 2, 1] } })
        expect(buildCommissionerSettingsChange({ ...changed, playoffRoundCount: '5' }, baseline, 'setup', ['points'], ['PG']))
            .toEqual({ error: 'Playoffs with 33 entrants need 6 rounds.' })
    })

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

    it('edits the trade deadline as a month and day that repeats every season', () => {
        expect(tradeDeadlineDraftValue('2027-02-11')).toBe('02/11')
        expect(tradeDeadlineDraftValue(null)).toBe('')

        const baseline = draft()
        expect(buildCommissionerSettingsChange(
            draft({ tradeDeadline: '2/11' }), baseline, 'active', ['points'], ['PG'],
        )).toMatchObject({ updates: { trade_deadline: '02-11' } })
        expect(buildCommissionerSettingsChange(
            draft({ tradeDeadline: '2/29' }), baseline, 'active', ['points'], ['PG'],
        )).toMatchObject({ updates: { trade_deadline: '02-29' } })
        expect(buildCommissionerSettingsChange(
            draft({ tradeDeadline: ' ' }), draft({ tradeDeadline: '02/11' }), 'active', ['points'], ['PG'],
        )).toMatchObject({ updates: { trade_deadline: null } })
        expect(buildCommissionerSettingsChange(
            draft({ tradeDeadline: '02/11' }), draft({ tradeDeadline: '02/11' }), 'active', ['points'], ['PG'],
        )).toEqual({ updates: {}, slotsChanged: false, slotUpdates: null })
        for (const invalid of ['2/30', '13/1', 'Feb 11', '2-11']) {
            expect(buildCommissionerSettingsChange(
                draft({ tradeDeadline: invalid }), baseline, 'active', ['points'], ['PG'],
            )).toEqual({ error: 'Trade deadline must be a month and day, like 2/11.' })
        }
    })

    it('rejects invalid values and lineup changes outside setup', () => {
        const baseline = draft()
        expect(buildCommissionerSettingsChange(
            draft({ playoffWeek: '0' }), baseline, 'setup', ['points'], ['PG'],
        )).toEqual({ error: 'Playoff start week must be a positive whole number.' })
        expect(buildCommissionerSettingsChange(
            draft({ slots: { PG: 2 } }), baseline, 'active', ['points'], ['PG'],
        )).toEqual({ error: 'Lineup slots can only be changed during league setup.' })
    })

    it('accepts positive custom starts and explicit round durations without clamping', () => {
        const baseline = draft()
        for (const start of ['1', '8', '16', '25', '30']) {
            expect(buildCommissionerSettingsChange(draft({ playoffWeek: start, playoffTotalWeeks: '5',
                playoffRoundWeeks: ['2', '3'] }), baseline, 'setup', ['points'], ['PG']))
                .toMatchObject({ updates: { playoff_start_week: Number(start), playoff_total_weeks: 5, playoff_round_weeks: [2, 3] } })
        }
        expect(buildCommissionerSettingsChange(draft({ playoffTotalWeeks: '5' }), baseline, 'setup', ['points'], ['PG']))
            .toEqual({ error: 'Round weeks must add up to total playoff weeks.' })
        expect(buildCommissionerSettingsChange(draft({ playoffRoundWeeks: ['1.5', '0.5'] }), baseline, 'setup', ['points'], ['PG']))
            .toEqual({ error: 'Enter positive whole weeks for each playoff round.' })
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

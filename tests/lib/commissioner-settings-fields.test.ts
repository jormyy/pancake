import { describe, expect, it } from 'vitest'
import { COMMISSIONER_SCORING_FIELDS } from '@/lib/commissioner-settings-fields'
import { buildCommissionerSettingsChange, type CommissionerSettingsDraft } from '@/lib/commissioner-settings-draft'

describe('commissioner scoring fields', () => {
    it('includes seeded bonuses when saving a scoring change', () => {
        const keys = COMMISSIONER_SCORING_FIELDS.map(({ key }) => key)
        const weights: Record<string, string> = { points: '1', double_double: '1.5', triple_double: '3' }
        const baseline: CommissionerSettingsDraft = {
            scoring: Object.fromEntries(keys.map((key) => [key, weights[key] ?? '0'])),
            slots: {}, rosterSize: '20', irSlots: '2', taxiSlots: '0', auctionBudget: '200',
            playoffWeek: '17', playoffTotalWeeks: '2', playoffRoundWeeks: ['1', '1'],
            weeklyAddLimit: '0', waiverMode: 'faab', faabBudget: '100', tradeVetoMode: 'member_vote',
            tradeVetoWindowHours: '24', tradeVetoThresholdPercent: '50', tradeDeadline: '',
        }
        const changed = { ...baseline, scoring: { ...baseline.scoring, points: '2' } }
        expect(buildCommissionerSettingsChange(changed, baseline, 'setup', keys, [])).toMatchObject({
            updates: { scoring_settings: { points: 2, double_double: 1.5, triple_double: 3 } },
        })
    })
})

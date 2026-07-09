import { describe, expect, it } from 'vitest'
import {
    DRAFT_STATUSES,
    DRAFT_TYPES,
    LEAGUE_STATUSES,
    MATCHUP_TYPES,
    NBA_POSITIONS,
    NOMINATION_STATUSES,
    ROSTER_SLOT_TYPES,
    TRADE_SIDES,
    TRADE_STATUSES,
    WAIVER_CLAIM_STATUSES,
} from '../src/types/enums'
import type { Database } from '../../types/database'

type DbEnums = Database['public']['Enums']

function expectEnumValues<K extends keyof DbEnums>(
    actual: readonly DbEnums[K][],
    expected: readonly DbEnums[K][],
) {
    expect([...actual].sort()).toEqual([...expected].sort())
}

describe('core enum mirrors', () => {
    it('match the generated database enum states used by shared callers', () => {
        expectEnumValues(LEAGUE_STATUSES, ['setup', 'drafting', 'active', 'playoffs', 'offseason', 'archived'])
        expectEnumValues(DRAFT_STATUSES, ['pending', 'in_progress', 'paused', 'completed', 'cancelled'])
        expectEnumValues(DRAFT_TYPES, ['auction', 'snake'])
        expectEnumValues(NOMINATION_STATUSES, ['open', 'sold', 'no_bid', 'withdrawn'])
        expectEnumValues(TRADE_STATUSES, [
            'pending',
            'accepted',
            'rejected',
            'withdrawn',
            'vetoed',
            'completed',
            'expired',
            'countered',
            'edited',
        ])
        expectEnumValues(TRADE_SIDES, ['proposer', 'recipient'])
        expectEnumValues(MATCHUP_TYPES, ['regular_season', 'playoff_quarterfinal', 'playoff_semifinal', 'playoff_final'])
        expectEnumValues(WAIVER_CLAIM_STATUSES, ['pending', 'succeeded', 'failed_priority', 'failed_roster', 'cancelled'])
        expectEnumValues(ROSTER_SLOT_TYPES, ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR'])
        expectEnumValues(NBA_POSITIONS, ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'])
    })
})

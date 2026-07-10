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
import { Constants } from '../../types/database'

const DB_ENUMS = Constants.public.Enums

function expectEnumValues(actual: readonly string[], expected: readonly string[]) {
    expect([...actual].sort()).toEqual([...expected].sort())
}

describe('core enum mirrors', () => {
    it('match the generated database enum states used by shared callers', () => {
        expectEnumValues(LEAGUE_STATUSES, DB_ENUMS.league_status)
        expectEnumValues(DRAFT_STATUSES, DB_ENUMS.draft_status)
        expectEnumValues(DRAFT_TYPES, DB_ENUMS.draft_type)
        expectEnumValues(NOMINATION_STATUSES, DB_ENUMS.nomination_status)
        expectEnumValues(TRADE_STATUSES, DB_ENUMS.trade_status)
        expectEnumValues(TRADE_SIDES, DB_ENUMS.trade_side)
        expectEnumValues(MATCHUP_TYPES, DB_ENUMS.matchup_type)
        expectEnumValues(WAIVER_CLAIM_STATUSES, DB_ENUMS.waiver_claim_status)
        expectEnumValues(ROSTER_SLOT_TYPES, DB_ENUMS.roster_slot_type)
        expectEnumValues(NBA_POSITIONS, DB_ENUMS.nba_position)
    })
})

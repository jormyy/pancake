import { describe, expect, it, vi } from 'vitest'

import type { RosterPlayer } from '@/lib/roster'
import { isDTD, isIREligible, isTaxiEligible } from '@/lib/roster'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/transactions', () => ({ logTransaction: vi.fn(), getLeagueTransactions: vi.fn(), TRANSACTION_LABELS: {} }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: vi.fn(), getActiveSeasonId: vi.fn(), getCurrentSeason: vi.fn(), currentSeasonYear: vi.fn() }))

// ── Mock players ───────────────────────────────────────────────────────────────

function mockPlayer(overrides: Partial<RosterPlayer['players']> = {}): RosterPlayer['players'] {
    return {
        id: 'p1',
        display_name: 'Test Player',
        nba_team: 'LAL',
        position: 'PG',
        eligible_positions: ['PG', 'G'],
        injury_status: null,
        nba_id: '123',
        nba_draft_number: null,
        years_exp: 1,
        ...overrides,
    }
}

// Roster of mock players covering different teams, positions, injury statuses, and draft numbers
const MOCK_PLAYERS: RosterPlayer['players'][] = [
    // Guards
    mockPlayer({ id: 'p-pg-lal',  display_name: 'Luka Doncic',       nba_team: 'LAL', position: 'PG', eligible_positions: ['PG', 'G'],       injury_status: null,    nba_id: '1629029', nba_draft_number: 3  }),
    mockPlayer({ id: 'p-sg-bos',  display_name: 'Jaylen Brown',       nba_team: 'BOS', position: 'SG', eligible_positions: ['SG', 'G', 'SF'],  injury_status: 'DTD',   nba_id: '1627759', nba_draft_number: null }),
    mockPlayer({ id: 'p-pg-gsw',  display_name: 'Stephen Curry',      nba_team: 'GSW', position: 'PG', eligible_positions: ['PG', 'G'],       injury_status: 'Out',   nba_id: '201939',  nba_draft_number: null }),
    mockPlayer({ id: 'p-sg-den',  display_name: 'Jamal Murray',       nba_team: 'DEN', position: 'SG', eligible_positions: ['PG', 'SG', 'G'], injury_status: 'IR',    nba_id: '1627750', nba_draft_number: null }),
    mockPlayer({ id: 'p-pg-okc',  display_name: 'Shai Gilgeous-Alex', nba_team: 'OKC', position: 'PG', eligible_positions: ['PG', 'SG', 'G'], injury_status: null,    nba_id: '1628983', nba_draft_number: null }),

    // Forwards
    mockPlayer({ id: 'p-sf-bos',  display_name: 'Jayson Tatum',       nba_team: 'BOS', position: 'SF', eligible_positions: ['SF', 'PF', 'F'],  injury_status: null,    nba_id: '1628369', nba_draft_number: null }),
    mockPlayer({ id: 'p-pf-min',  display_name: 'Karl-Anthony Towns', nba_team: 'MIN', position: 'PF', eligible_positions: ['PF', 'C', 'F'],   injury_status: 'DTD',   nba_id: '1626157', nba_draft_number: null }),
    mockPlayer({ id: 'p-sf-phi',  display_name: 'Paul George',        nba_team: 'PHI', position: 'SF', eligible_positions: ['SF', 'PF', 'F'],  injury_status: 'IR-LTI',nba_id: '202331',  nba_draft_number: null }),
    mockPlayer({ id: 'p-pf-mil',  display_name: 'Giannis Anteto.',    nba_team: 'MIL', position: 'PF', eligible_positions: ['PF', 'C', 'F'],   injury_status: 'Out',   nba_id: '203507',  nba_draft_number: null }),
    mockPlayer({ id: 'p-sf-sas',  display_name: 'Keldon Johnson',     nba_team: 'SAS', position: 'SF', eligible_positions: ['SF', 'F'],        injury_status: null,    nba_id: '1629010', nba_draft_number: null }),

    // Centers
    mockPlayer({ id: 'p-c-den',   display_name: 'Nikola Jokic',       nba_team: 'DEN', position: 'C',  eligible_positions: ['C', 'PF'],        injury_status: null,    nba_id: '203999',  nba_draft_number: null }),
    mockPlayer({ id: 'p-c-phi',   display_name: 'Joel Embiid',        nba_team: 'PHI', position: 'C',  eligible_positions: ['C', 'PF'],        injury_status: 'Out',   nba_id: '203954',  nba_draft_number: null }),
    mockPlayer({ id: 'p-c-cha',   display_name: 'Nick Richards',      nba_team: 'CHA', position: 'C',  eligible_positions: ['C'],              injury_status: null,    nba_id: '1630199', nba_draft_number: null }),
    mockPlayer({ id: 'p-c-nop',   display_name: 'Yves Missi',         nba_team: 'NOP', position: 'C',  eligible_positions: ['C'],              injury_status: null,    nba_id: '1642307', nba_draft_number: 21 }),
    mockPlayer({ id: 'p-c-sas',   display_name: 'Victor Wembanyama',  nba_team: 'SAS', position: 'C',  eligible_positions: ['C', 'PF'],        injury_status: null,    nba_id: '1641705', nba_draft_number: 1  }),

    // Current rookies / recent draft picks (taxi-eligible)
    mockPlayer({ id: 'p-r-atl',   display_name: 'Zaccharie Risacher', nba_team: 'ATL', position: 'SF', eligible_positions: ['SF', 'F'],        injury_status: null,    nba_id: '1642301', nba_draft_number: 1,  years_exp: 0 }),
    mockPlayer({ id: 'p-r-was',   display_name: 'Alex Sarr',          nba_team: 'WAS', position: 'C',  eligible_positions: ['C', 'PF'],        injury_status: null,    nba_id: '1642302', nba_draft_number: 2,  years_exp: 0 }),
    mockPlayer({ id: 'p-r-por',   display_name: 'Donovan Clingan',    nba_team: 'POR', position: 'C',  eligible_positions: ['C'],              injury_status: 'DTD',   nba_id: '1642305', nba_draft_number: 7,  years_exp: 0 }),
    mockPlayer({ id: 'p-r-mem',   display_name: 'Zach Edey',          nba_team: 'MEM', position: 'C',  eligible_positions: ['C'],              injury_status: null,    nba_id: '1642306', nba_draft_number: 9,  years_exp: 0 }),
    mockPlayer({ id: 'p-r-late',  display_name: 'Late 2nd Rounder',   nba_team: 'CLE', position: 'PG', eligible_positions: ['PG', 'G'],        injury_status: null,    nba_id: '9999999', nba_draft_number: 58, years_exp: 0 }),

    // Veterans with no draft number stored (pre-database era or undrafted vets)
    mockPlayer({ id: 'p-v-lal',   display_name: 'LeBron James',       nba_team: 'LAL', position: 'SF', eligible_positions: ['SF', 'PF', 'F'],  injury_status: null,    nba_id: '2544',    nba_draft_number: null }),
    mockPlayer({ id: 'p-v-gsw',   display_name: 'Draymond Green',     nba_team: 'GSW', position: 'PF', eligible_positions: ['PF', 'C', 'F'],   injury_status: 'DTD',   nba_id: '203110',  nba_draft_number: null }),
    mockPlayer({ id: 'p-v-bkn',   display_name: 'Undrafted Vet',      nba_team: 'BKN', position: 'SG', eligible_positions: ['SG', 'G'],        injury_status: null,    nba_id: '888888',  nba_draft_number: null }),
]

// ── isIREligible ───────────────────────────────────────────────────────────────

describe('isIREligible', () => {
    it('returns true for "out"', () => expect(isIREligible('out')).toBe(true))
    it('returns true for "Out" (case insensitive)', () => expect(isIREligible('Out')).toBe(true))
    it('returns true for "OUT"', () => expect(isIREligible('OUT')).toBe(true))
    it('returns true for "IR"', () => expect(isIREligible('IR')).toBe(true))
    it('returns true for "IR-LTI"', () => expect(isIREligible('IR-LTI')).toBe(true))
    it('returns true for "ir-out"', () => expect(isIREligible('ir-out')).toBe(true))
    it('returns false for "DTD"', () => expect(isIREligible('DTD')).toBe(false))
    it('returns false for "dtd"', () => expect(isIREligible('dtd')).toBe(false))
    it('returns false for "active"', () => expect(isIREligible('active')).toBe(false))
    it('returns false for empty string', () => expect(isIREligible('')).toBe(false))
    it('returns false for null', () => expect(isIREligible(null)).toBe(false))
})

// ── isDTD ──────────────────────────────────────────────────────────────────────

describe('isDTD', () => {
    it('returns true for "dtd"', () => expect(isDTD('dtd')).toBe(true))
    it('returns true for "DTD"', () => expect(isDTD('DTD')).toBe(true))
    it('returns false for "out"', () => expect(isDTD('out')).toBe(false))
    it('returns false for "IR"', () => expect(isDTD('IR')).toBe(false))
    it('returns false for "IR-LTI"', () => expect(isDTD('IR-LTI')).toBe(false))
    it('returns false for null', () => expect(isDTD(null)).toBe(false))
    it('returns false for empty string', () => expect(isDTD('')).toBe(false))
})

// ── isTaxiEligible ─────────────────────────────────────────────────────────────

describe('isTaxiEligible', () => {
    it('returns true when nba_draft_number is a positive integer', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: 1, years_exp: 0 }))).toBe(true)
    })

    it('returns true when nba_draft_number is 0', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: 0, years_exp: 0 }))).toBe(true)
    })

    it('returns false when nba_draft_number is null', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: null, years_exp: 0 }))).toBe(false)
    })

    it('returns false when a veteran has stale draft metadata', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: 1, years_exp: 1 }))).toBe(false)
    })

    it('returns true for a high 2nd-round pick (pick 58)', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: 58, years_exp: 0 }))).toBe(true)
    })

    it('all mock veterans without a draft number are not taxi-eligible', () => {
        const vets = MOCK_PLAYERS.filter((p) => p.id.startsWith('p-v-'))
        expect(vets.length).toBeGreaterThan(0)
        vets.forEach((p) => expect(isTaxiEligible(p)).toBe(false))
    })

    it('taxi eligibility is independent of injury status', () => {
        // A DTD rookie is still taxi-eligible
        const dtdRookie = MOCK_PLAYERS.find((p) => p.id === 'p-r-por')! // Clingan, DTD
        expect(isDTD(dtdRookie.injury_status)).toBe(true)
        expect(isTaxiEligible(dtdRookie)).toBe(true)
    })

    it('taxi eligibility is independent of position', () => {
        const positions = ['PG', 'SG', 'SF', 'PF', 'C']
        positions.forEach((pos) => {
            const withDraftNum = mockPlayer({ position: pos, eligible_positions: [pos], nba_draft_number: 5, years_exp: 0 })
            const withoutDraftNum = mockPlayer({ position: pos, eligible_positions: [pos], nba_draft_number: null, years_exp: 0 })
            expect(isTaxiEligible(withDraftNum)).toBe(true)
            expect(isTaxiEligible(withoutDraftNum)).toBe(false)
        })
    })

    it('taxi eligibility is independent of team', () => {
        const teams = ['LAL', 'BOS', 'GSW', 'DEN', 'MIL', 'SAS', 'OKC', 'PHI', 'MIN', 'NOP']
        teams.forEach((team) => {
            expect(isTaxiEligible(mockPlayer({ nba_team: team, nba_draft_number: 10, years_exp: 0 }))).toBe(true)
            expect(isTaxiEligible(mockPlayer({ nba_team: team, nba_draft_number: null, years_exp: 0 }))).toBe(false)
        })
    })
})

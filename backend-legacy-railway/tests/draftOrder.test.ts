import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('axios', () => ({ default: { get: vi.fn() } }))
vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

import axios from 'axios'
import { supabase } from '../src/lib/supabase'
import {
    isDraftOrderAutoSyncWindow,
    parseDraftPicksFromArticleText,
    syncDraftOrder,
} from '../src/sync/draftOrder'

const mockAxiosGet = vi.mocked(axios.get)
const mockFrom = vi.mocked(supabase.from)

type PlayerRow = {
    id: string
    first_name: string
    last_name: string
    display_name: string
    years_exp?: number | null
    nba_draft_number?: number | null
}

beforeEach(() => {
    vi.clearAllMocks()
})

function statsResponse(rows: any[][]) {
    return {
        data: {
            resultSets: [{
                headers: [
                    'PERSON_ID',
                    'PLAYER_NAME',
                    'SEASON',
                    'ROUND_NUMBER',
                    'ROUND_PICK',
                    'OVERALL_PICK',
                    'DRAFT_TYPE',
                    'TEAM_ID',
                    'TEAM_CITY',
                    'TEAM_NAME',
                    'TEAM_ABBREVIATION',
                ],
                rowSet: rows,
            }],
        },
    }
}

function nbaArticleHtml(contentText: string) {
    return `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { article: { contentText } } },
    })}</script>`
}

function draftArticleText(count: number) {
    return Array.from({ length: count }, (_, index) => {
        const pick = index + 1
        return `${pick}. Team ${pick} draft Player ${pick} (College ${pick})`
    }).join('\n')
}

function setupPlayersStore(initialPlayers: PlayerRow[]) {
    const players = initialPlayers.map((player) => ({ ...player }))
    let insertedCount = 0
    const updated: any[] = []

    mockFrom.mockImplementation((table: string) => {
        if (table !== 'players') throw new Error(`Unexpected table ${table}`)
        return {
            select: () => selectPlayersChain(players),
            insert: (rows: any[]) => ({
                select: () => {
                    const inserted = rows.map((row) => {
                        insertedCount += 1
                        const player = {
                            id: `inserted-${insertedCount}`,
                            first_name: row.first_name,
                            last_name: row.last_name,
                            display_name: `${row.first_name} ${row.last_name}`,
                            years_exp: row.years_exp ?? null,
                            nba_draft_number: row.nba_draft_number ?? null,
                        }
                        players.push(player)
                        return player
                    })
                    return Promise.resolve({ data: inserted, error: null })
                },
            }),
            update: (fields: any) => ({
                eq: (_column: string, id: string) => {
                    updated.push({ id, ...fields })
                    const player = players.find((p) => p.id === id)
                    if (player) Object.assign(player, fields)
                    return Promise.resolve({ data: null, error: null })
                },
            }),
        } as any
    })

    return { players, updated }
}

function selectPlayersChain(players: PlayerRow[]) {
    const chain: any = {
        range: (from: number, to: number) => Promise.resolve({
            data: players.slice(from, to + 1),
            error: null,
        }),
        eq: () => chain,
        not: () => chain,
        order: () => Promise.resolve({
            data: players
                .filter((player) => player.years_exp === 0 && player.nba_draft_number != null)
                .sort((a, b) => Number(a.nba_draft_number) - Number(b.nba_draft_number)),
            error: null,
        }),
    }
    return chain
}

function player(name: string, id = name.toLowerCase().replaceAll(' ', '-')): PlayerRow {
    const [firstName, ...lastNameParts] = name.split(' ')
    return {
        id,
        first_name: firstName,
        last_name: lastNameParts.join(' ') || firstName,
        display_name: name,
        years_exp: null,
        nba_draft_number: null,
    }
}

describe('parseDraftPicksFromArticleText', () => {
    it('parses numbered NBA.com result lines, including typo-like "from" lines', () => {
        const picks = parseDraftPicksFromArticleText(`
          > 2026 Round 1 Draft Results
          1. Washington Wizards draft AJ Dybantsa (BYU)
          6. Brooklyn Nets draft Mikel Brown Jr. (Louisville)
          16. Memphis Grizzlies from Bennett Stirtz (Iowa) (Traded to Oklahoma City)
          42. San Antonio Spurs draft Ja'Kobi Gillespie (Tennessee)
        `)

        expect(picks).toEqual([
            expect.objectContaining({ overallPick: 1, playerName: 'AJ Dybantsa', teamName: 'Washington Wizards' }),
            expect.objectContaining({ overallPick: 6, playerName: 'Mikel Brown Jr.', teamName: 'Brooklyn Nets' }),
            expect.objectContaining({ overallPick: 16, playerName: 'Bennett Stirtz', teamName: 'Memphis Grizzlies' }),
            expect.objectContaining({ overallPick: 42, playerName: "Ja'Kobi Gillespie", teamName: 'San Antonio Spurs' }),
        ])
    })
})

describe('isDraftOrderAutoSyncWindow', () => {
    it('only opens during late June and early July', () => {
        expect(isDraftOrderAutoSyncWindow(new Date('2027-06-19T12:00:00Z'))).toBe(false)
        expect(isDraftOrderAutoSyncWindow(new Date('2027-06-20T12:00:00Z'))).toBe(true)
        expect(isDraftOrderAutoSyncWindow(new Date('2027-07-15T12:00:00Z'))).toBe(true)
        expect(isDraftOrderAutoSyncWindow(new Date('2027-07-16T12:00:00Z'))).toBe(false)
    })

    it('uses Eastern Time day boundaries for the auto-sync window', () => {
        expect(isDraftOrderAutoSyncWindow(new Date('2027-06-20T03:30:00Z'))).toBe(false)
        expect(isDraftOrderAutoSyncWindow(new Date('2027-06-20T04:30:00Z'))).toBe(true)
        expect(isDraftOrderAutoSyncWindow(new Date('2027-07-16T03:30:00Z'))).toBe(true)
        expect(isDraftOrderAutoSyncWindow(new Date('2027-07-16T04:30:00Z'))).toBe(false)
    })
})

describe('syncDraftOrder', () => {
    it('falls back to NBA.com, inserts missing players, tags rookies, and clears stale draft numbers', async () => {
        const existing = Array.from({ length: 48 }, (_, index) => player(`Player ${index + 1}`))
        existing.push({
            ...player('Old Board Player', 'old-board-player'),
            years_exp: 0,
            nba_draft_number: 12,
        })
        const store = setupPlayersStore(existing)

        mockAxiosGet
            .mockResolvedValueOnce(statsResponse([]))
            .mockResolvedValueOnce({ data: nbaArticleHtml(draftArticleText(50)) })

        const result = await syncDraftOrder(2027)

        expect(result).toMatchObject({
            seasonYear: 2027,
            source: 'nba.com',
            draftPickCount: 50,
            updated: 50,
            inserted: 2,
            staleDraftNumbersCleared: 1,
            unmatched: [],
        })
        expect(store.players.filter((p) => p.years_exp === 0 && p.nba_draft_number != null)).toHaveLength(50)
        expect(store.players.find((p) => p.id === 'old-board-player')?.nba_draft_number).toBeNull()
        expect(store.updated).toContainEqual(expect.objectContaining({ nba_draft_number: 1, years_exp: 0 }))
        expect(store.updated).toContainEqual(expect.objectContaining({ nba_draft_number: 50, years_exp: 0 }))
    })

    it('uses stats.nba.com when it has a complete board', async () => {
        setupPlayersStore(Array.from({ length: 50 }, (_, index) => player(`Player ${index + 1}`)))
        mockAxiosGet.mockResolvedValueOnce(statsResponse(
            Array.from({ length: 50 }, (_, index) => {
                const pick = index + 1
                return [
                    `person-${pick}`,
                    `Player ${pick}`,
                    '2027',
                    pick <= 30 ? 1 : 2,
                    pick <= 30 ? pick : pick - 30,
                    pick,
                    'Draft',
                    `team-${pick}`,
                    'Team',
                    `${pick}`,
                    `T${pick}`,
                ]
            }),
        ))

        const result = await syncDraftOrder(2027)

        expect(result.source).toBe('stats.nba.com')
        expect(mockAxiosGet).toHaveBeenCalledTimes(1)
    })
})

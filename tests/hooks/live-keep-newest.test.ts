import { describe, expect, it } from 'vitest'
import type { LiveSnapshot } from '@pancake/core'
import { keepNewestGames } from '@/hooks/use-public-live-snapshot'

const game = (id: string, away: string, home: string, updatedAt: number, score: number): LiveSnapshot['games'][number] =>
    ({ id, nbaId: null, espnId: null, status: 'InProgress', updatedAt, home: { team: home, score, players: [] }, away: { team: away, score: 0, players: [] } })
const snap = (capturedAt: number, games: LiveSnapshot['games']): LiveSnapshot => ({ version: 1, mode: 'public', date: '2026-11-02', capturedAt, games })

describe('keepNewestGames', () => {
    it('keeps a dropped game and never moves a game backwards', () => {
        const first = snap(100, [game('espn:1', 'OKC', 'CLE', 90, 61), game('espn:2', 'ATL', 'IND', 90, 54)])
        const second = snap(130, [game('0022', 'OKC', 'CLE', 80, 59)])
        const merged = keepNewestGames(first, second)!
        expect(merged.capturedAt).toBe(130)
        expect(merged.games.map(row => [row.home.team, row.home.score]).sort()).toEqual([['CLE', 61], ['IND', 54]])
    })
})

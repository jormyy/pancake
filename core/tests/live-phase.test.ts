import { describe, expect, it } from 'vitest'
import { gameAvailable, gamePhase, type GamePhase, type PhaseGame } from '../src/live/phase'

const cases: [PhaseGame, GamePhase][] = [
    [{ status: 'Scheduled', game_status_text: '7:30 pm ET' }, 'upcoming'],
    [{ status: 'Scheduled', game_status_text: 'PPD - postponed' }, 'unavailable'],
    [{ status: 'Scheduled', game_status_text: 'PPD' }, 'unavailable'],
    [{ status: 'Scheduled', game_status_text: 'Postponed' }, 'unavailable'],
    [{ status: 'Scheduled', game_status_text: 'Cancelled: absent from complete schedule' }, 'unavailable'],
    [{ status: 'InProgress', game_status_text: 'Suspended' }, 'unavailable'],
    [{ status: 'InProgress', game_status_text: 'Q3 4:12' }, 'live'],
    [{ status: 'Final', game_status_text: 'Final', stats_synced_at: null }, 'finalPending'],
    [{ status: 'Final', game_status_text: 'Final', stats_synced_at: '2026-11-22T05:00:00Z' }, 'settled'],
    [{ status: 'Final', game_status_text: 'Final/OT' }, 'settled'],
    [{ status: 'Scheduled', game_status_text: 'Upper deck opening' }, 'upcoming'],
    [{ status: null }, 'unavailable'],
]

describe('game phase', () => {
    it.each(cases)('%j is %s', (game, phase) => {
        expect(gamePhase(game)).toBe(phase)
        expect(gameAvailable(game)).toBe(phase !== 'unavailable')
    })
})

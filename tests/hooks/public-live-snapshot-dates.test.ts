import { describe, expect, it } from 'vitest'
import { liveSnapshotDates } from '@/hooks/use-public-live-snapshot'

const tipped = '2026-11-21T00:00:00Z'
const now = Date.parse('2026-11-21T01:00:00Z')
const game = (game_date: string, status: string, game_status_text: string | null, stats_synced_at: string | null = null) =>
    ({ nba_game_id: `002${game_date}`, game_date, game_time: tipped, status, game_status_text, stats_synced_at })

describe('public live snapshot dates', () => {
    it('polls only days with a game that can still change', () => {
        expect(liveSnapshotDates([
            game('2026-11-18', 'Scheduled', 'PPD - postponed'),
            game('2026-11-19', 'InProgress', 'Suspended'),
            game('2026-11-20', 'Scheduled', 'Cancelled'),
            game('2026-11-21', 'Final', 'Final', '2026-11-21T04:00:00Z'),
        ], '2026-11-21', now)).toBe('')
        expect(liveSnapshotDates([
            game('2026-11-19', 'Final', 'Final'),
            game('2026-11-20', 'InProgress', 'Q2 3:00'),
            game('2026-11-21', 'Scheduled', '7:00 pm ET'),
        ], '2026-11-21', now)).toBe('2026-11-19,2026-11-20,2026-11-21')
    })
})

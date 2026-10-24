import type { PlayerSeasonLine } from '@/components/player/season-data'

export function seasonLine(overrides: Partial<PlayerSeasonLine> = {}): PlayerSeasonLine {
    return {
        id: 'stat', game_date: '2026-10-23', did_not_play: false, minutes_played: 32.5,
        points: 24, rebounds: 8, assists: 10, steals: 2, blocks: 1, turnovers: 3, personal_fouls: 2,
        field_goals_made: 8, field_goals_attempted: 16, three_pointers_made: 3, three_pointers_attempted: 7,
        free_throws_made: 5, free_throws_attempted: 6, plus_minus: 8, double_double: true, triple_double: false,
        nba_games: { id: 'nba-game', nba_game_id: '0022600001', game_date: '2026-10-23',
            home_team: 'LAL', away_team: 'BOS', status: 'final', game_time: '2026-10-23T23:00:00Z', started_at: '2026-10-23T23:00:00Z' },
        ...overrides,
    }
}

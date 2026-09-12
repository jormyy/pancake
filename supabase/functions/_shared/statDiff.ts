import type { Database } from './database.ts'

type PlayerGameStatsInsert = Database['public']['Tables']['player_game_stats']['Insert']

// Columns that decide whether a box score actually moved. updated_at is excluded
// on purpose: it is the signal loadEarliestStatCorrectionWeek uses to detect a
// stat correction, so rewriting it on an unchanged re-sync would make every
// re-sync look like a correction and drag the scoring reach-back back to week 1.
export const COMPARED_STAT_COLUMNS = [
  'player_id',
  'game_id',
  'season_year',
  'week_number',
  'minutes_played',
  'points',
  'rebounds',
  'offensive_rebounds',
  'defensive_rebounds',
  'assists',
  'steals',
  'blocks',
  'turnovers',
  'personal_fouls',
  'field_goals_made',
  'field_goals_attempted',
  'three_pointers_made',
  'three_pointers_attempted',
  'free_throws_made',
  'free_throws_attempted',
  'plus_minus',
  'double_double',
  'triple_double',
  'did_not_play',
] as const

// Pure half of the diff. This module must never import the Supabase client so it
// stays importable (and testable) without credentials.
export function changedStatRows(
  rows: PlayerGameStatsInsert[],
  storedRows: Record<string, unknown>[],
): PlayerGameStatsInsert[] {
  const stored = new Map<string, Record<string, unknown>>(
    storedRows.map((row) => [String(row.player_id), row]),
  )
  return rows.filter((row) => !statRowMatchesStored(row, stored.get(String(row.player_id))))
}

function statRowMatchesStored(
  row: PlayerGameStatsInsert,
  stored: Record<string, unknown> | undefined,
): boolean {
  if (!stored) return false
  return COMPARED_STAT_COLUMNS.every((column) =>
    normalizeStatValue((row as Record<string, unknown>)[column]) === normalizeStatValue(stored[column]),
  )
}

// Postgres returns numerics as strings ("12.50"); normalize both sides through
// Number so formatting alone never counts as a change.
function normalizeStatValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const numeric = Number(value)
  if (value !== '' && !Number.isNaN(numeric)) return String(numeric)
  return String(value)
}

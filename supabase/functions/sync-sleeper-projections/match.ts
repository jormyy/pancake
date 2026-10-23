import { normalizeName } from '../_shared/nameMatch.ts'
import { normalizeFantasyProsTeam } from '../sync-projections/match.ts'
import type { SleeperProjection } from './parser.ts'

export type SleeperPlayer = { id: string; sleeper_id: string | null; display_name: string | null; nba_team: string | null }

export function matchSleeperProjections(rows: SleeperProjection[], players: SleeperPlayer[], seasonYear: number, weekNumber: number) {
  const byId = new Map<string, SleeperPlayer[]>()
  const byNameTeam = new Map<string, SleeperPlayer[]>()
  const add = (map: Map<string, SleeperPlayer[]>, key: string, player: SleeperPlayer) => map.set(key, [...(map.get(key) ?? []), player])
  for (const player of players) {
    if (player.sleeper_id) add(byId, player.sleeper_id, player)
    if (player.display_name && player.nba_team) add(byNameTeam,
      `${normalizeName(player.display_name)}:${normalizeFantasyProsTeam(player.nba_team)}`, player)
  }
  const unmatched: string[] = []
  const matched = rows.flatMap((row) => {
    const ids = byId.get(row.player_id) ?? []
    const names = byNameTeam.get(`${normalizeName(`${row.player.first_name} ${row.player.last_name}`)}:${normalizeFantasyProsTeam(row.team)}`) ?? []
    const candidates = ids.length ? ids : names.length === 1 && !names[0].sleeper_id ? names : []
    if (candidates.length !== 1) { unmatched.push(`${row.player_id}:${row.game_id}`); return [] }
    return [{
      player_id: candidates[0].id, source_game_id: row.game_id, sleeper_id: row.player_id,
      season_year: seasonYear, week_number: weekNumber, game_date: row.date,
      team: normalizeFantasyProsTeam(row.team), opponent: normalizeFantasyProsTeam(row.opponent),
      points: row.stats.pts, rebounds: row.stats.reb, assists: row.stats.ast, steals: row.stats.stl,
      blocks: row.stats.blk, turnovers: row.stats.to, three_pointers_made: row.stats.tpm,
      field_goals_made: row.stats.fgm, field_goals_attempted: row.stats.fga,
      free_throws_made: row.stats.ftm, free_throws_attempted: row.stats.fta,
      three_pointers_attempted: row.stats.tpa, minutes: row.stats.sp / 60,
      double_doubles: row.stats.dd ?? null, triple_doubles: row.stats.td ?? null,
      last_modified: row.last_modified,
    }]
  })
  if (new Set(matched.map((row) => `${row.player_id}:${row.source_game_id}`)).size !== matched.length) throw new Error('Sleeper IDs resolve to duplicate player-games')
  return { rows: matched, matched: matched.length, unmatched: unmatched.length, unmatchedIds: unmatched.slice(0, 30) }
}

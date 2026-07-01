import { normalizeName } from '../_shared/nameMatch.ts'
import type { Database } from '../_shared/database.ts'
import type { FantasyProsProjectionRow, FantasyProsProjectionType } from './parser.ts'

export type PlayerForProjection = {
  id: string
  display_name: string | null
  nba_team: string | null
  status: string | null
}

export type FantasyProsProjectionInsert =
  Database['public']['Tables']['fantasypros_projection_rows']['Insert']

type PlayerMaps = {
  byNormName: Map<string, PlayerForProjection[]>
}

const TEAM_ALIASES: Record<string, string> = {
  ATL: 'ATL',
  BOS: 'BOS',
  BKN: 'BKN',
  BRK: 'BKN',
  CHA: 'CHA',
  CHI: 'CHI',
  CLE: 'CLE',
  DAL: 'DAL',
  DEN: 'DEN',
  DET: 'DET',
  GS: 'GSW',
  GSW: 'GSW',
  HOU: 'HOU',
  IND: 'IND',
  LAC: 'LAC',
  LAL: 'LAL',
  MEM: 'MEM',
  MIA: 'MIA',
  MIL: 'MIL',
  MIN: 'MIN',
  NO: 'NOP',
  NOR: 'NOP',
  NOP: 'NOP',
  NY: 'NYK',
  NYK: 'NYK',
  OKC: 'OKC',
  ORL: 'ORL',
  PHI: 'PHI',
  PHO: 'PHX',
  PHX: 'PHX',
  POR: 'POR',
  SA: 'SAS',
  SAS: 'SAS',
  SAC: 'SAC',
  TOR: 'TOR',
  UTA: 'UTA',
  UTH: 'UTA',
  WAS: 'WAS',
}

const FANTASYPROS_NAME_ALIASES: Record<string, string[]> = {
  'nicolas claxton': ['Nic Claxton'],
  'carlton carrington': ['Bub Carrington'],
  'ron holland': ['Ronald Holland'],
  'alexandre sarr': ['Alex Sarr'],
  'nigel hayes davis': ['Nigel Hayes-Davis'],
  'ishmail wainright': ['Ish Wainright'],
}

export function normalizeFantasyProsTeam(team: string | null): string | null {
  if (!team) return null
  const upper = team.toUpperCase()
  if (upper === 'FA') return null
  return TEAM_ALIASES[upper] ?? upper
}

export function buildFantasyProsProjectionPayload({
  runId,
  projectionType,
  sourceUrl,
  rows,
  players,
  fetchedAt,
  seasonYear,
  weekNumber,
  projectionDate,
}: {
  runId: string
  projectionType: FantasyProsProjectionType
  sourceUrl: string
  rows: FantasyProsProjectionRow[]
  players: PlayerForProjection[]
  fetchedAt: string
  seasonYear: number | null
  weekNumber: number | null
  projectionDate: string | null
}): { rows: FantasyProsProjectionInsert[]; matched: number; unmatched: number } {
  const maps = buildPlayerMaps(players)
  let matched = 0
  let unmatched = 0

  const inserts = rows.map((row): FantasyProsProjectionInsert => {
    const match = findPlayerForProjection(row, maps)
    if (match.player) matched++
    else unmatched++

    return {
      run_id: runId,
      projection_type: projectionType,
      source_url: sourceUrl,
      source_row_number: row.sourceRowNumber,
      season_year: seasonYear,
      week_number: weekNumber,
      projection_date: projectionDate,
      fetched_at: fetchedAt,
      source_player_name: row.name,
      normalized_player_name: row.normalizedName,
      source_team: normalizeFantasyProsTeam(row.team),
      source_positions: row.positions,
      source_status: row.status,
      source_opponent: row.opponent,
      player_id: match.player?.id ?? null,
      match_status: match.status,
      match_reason: match.reason,
      points: row.points,
      rebounds: row.rebounds,
      assists: row.assists,
      steals: row.steals,
      blocks: row.blocks,
      three_pointers_made: row.three_pointers_made,
      turnovers: row.turnovers,
      minutes: row.minutes,
      games_played: row.games_played,
      field_goal_pct: row.field_goal_pct,
      free_throw_pct: row.free_throw_pct,
      raw_player_cell: row.rawPlayerCell,
      raw_stats: row.rawStats,
    }
  })

  return { rows: inserts, matched, unmatched }
}

function buildPlayerMaps(players: PlayerForProjection[]): PlayerMaps {
  const byNormName = new Map<string, PlayerForProjection[]>()
  for (const player of players) {
    if (!player.display_name) continue
    pushMap(byNormName, normalizeName(player.display_name), player)
  }
  return { byNormName }
}

function pushMap(map: Map<string, PlayerForProjection[]>, key: string, player: PlayerForProjection): void {
  const existing = map.get(key)
  if (existing) existing.push(player)
  else map.set(key, [player])
}

function findPlayerForProjection(
  row: FantasyProsProjectionRow,
  maps: PlayerMaps,
): {
  player: PlayerForProjection | null
  status: 'matched' | 'unmatched' | 'ambiguous'
  reason: string
} {
  const names = projectionLookupNames(row.name)
  for (const name of names) {
    const candidates = maps.byNormName.get(normalizeName(name)) ?? []
    const picked = pickBestCandidate(candidates, row.team)
    if (picked.status !== 'unmatched') return picked
  }
  return { player: null, status: 'unmatched', reason: 'no normalized-name match' }
}

function projectionLookupNames(name: string): string[] {
  const aliases = FANTASYPROS_NAME_ALIASES[normalizeName(name)] ?? []
  return [name, ...aliases]
}

function pickBestCandidate(
  candidates: PlayerForProjection[],
  sourceTeam: string | null,
): {
  player: PlayerForProjection | null
  status: 'matched' | 'unmatched' | 'ambiguous'
  reason: string
} {
  if (candidates.length === 0) return { player: null, status: 'unmatched', reason: 'no candidates' }
  if (candidates.length === 1) {
    const team = normalizeFantasyProsTeam(sourceTeam)
    const playerTeam = normalizeFantasyProsTeam(candidates[0].nba_team)
    return {
      player: candidates[0],
      status: 'matched',
      reason: team && playerTeam === team ? 'normalized-name and team match' : 'unique normalized-name match',
    }
  }

  const team = normalizeFantasyProsTeam(sourceTeam)
  if (team) {
    const teamMatches = candidates.filter((player) => normalizeFantasyProsTeam(player.nba_team) === team)
    if (teamMatches.length === 1) {
      return { player: teamMatches[0], status: 'matched', reason: 'normalized-name and team match' }
    }
    if (teamMatches.length > 1) {
      return { player: null, status: 'ambiguous', reason: 'multiple normalized-name and team matches' }
    }
  }

  const active = candidates.filter((player) => !['Inactive', 'RET', 'Retired'].includes(player.status ?? ''))
  if (active.length === 1) return { player: active[0], status: 'matched', reason: 'unique active normalized-name match' }

  return { player: null, status: 'ambiguous', reason: 'multiple normalized-name matches' }
}

import { normalizeName } from '../_shared/nameMatch.ts'
import { isDraftPlaceholder, normalizeTeam, type RankingRow, type RankingStats } from './parser.ts'

export const RANKINGS_SOURCE = 'hashtagbasketball.com'

export type PlayerForRanking = {
  id: string
  display_name: string | null
  sportsdata_id: string | null
  sleeper_id: string | null
  nba_id: string | null
  nba_team: string | null
  status: string | null
}

type PlayerMaps = {
  bySpDataId: Map<string, PlayerForRanking[]>
  byExactName: Map<string, PlayerForRanking[]>
  byNormName: Map<string, PlayerForRanking[]>
}

export type DynastyRankingInsert = RankingStats & {
  source: string
  source_rank: number
  source_player_id: string | null
  source_player_name: string
  source_team: string | null
  source_positions: string[]
  player_id: string | null
  age: number | null
  rank_change: number
  comment: string | null
  fetched_at: string
}

export type RankingPayload = {
  rows: DynastyRankingInsert[]
  matched: number
}

const HASHTAG_NAME_ALIASES: Record<string, string[]> = {
  'alexandre sarr': ['Alex Sarr'],
  'nicolas claxton': ['Nic Claxton'],
  'carlton carrington': ['Bub Carrington'],
  'ron holland': ['Ronald Holland'],
  'nikola djurisic': ['Nikola Đurišić'],
  'nigel hayes': ['Nigel Hayes-Davis'],
  'david jones': ['David Jones-Garcia', 'David Jones Garcia'],
  'ishmail wainright': ['Ish Wainright'],
  'aleksandar vezenkov': ['Sasha Vezenkov'],
  'jacky cui': ['Cui Yongxi'],
}

export function buildDynastyRankingPayload(
  rankings: RankingRow[],
  players: PlayerForRanking[],
  fetchedAt: string,
): RankingPayload {
  const playerMaps = buildPlayerMaps(players)
  let matched = 0
  const rows: DynastyRankingInsert[] = []

  for (const ranking of rankings) {
    // Draft-pick placeholders (e.g. "2026 Draft (Pick 1)") are kept as ranked
    // rows but never matched to a player — findPlayerForRanking returns null for
    // them, so they store unmatched (player_id null) with the source's empty stats.
    const player = findPlayerForRanking(ranking, playerMaps)
    rows.push({
      source: RANKINGS_SOURCE,
      source_rank: ranking.rank,
      source_player_id: ranking.sourcePlayerId,
      source_player_name: ranking.name,
      source_team: normalizeTeam(ranking.team),
      source_positions: ranking.positions,
      player_id: player?.id ?? null,
      age: ranking.age,
      rank_change: ranking.rankChange,
      games_played: ranking.games_played,
      field_goal_pct: ranking.field_goal_pct,
      free_throw_pct: ranking.free_throw_pct,
      three_pointers_made: ranking.three_pointers_made,
      points: ranking.points,
      rebounds: ranking.rebounds,
      assists: ranking.assists,
      steals: ranking.steals,
      blocks: ranking.blocks,
      turnovers: ranking.turnovers,
      comment: ranking.comment,
      fetched_at: fetchedAt,
    })

    if (player) matched++
  }

  return { rows, matched }
}

function buildPlayerMaps(players: PlayerForRanking[]): PlayerMaps {
  const maps: PlayerMaps = {
    bySpDataId: new Map(),
    byExactName: new Map(),
    byNormName: new Map(),
  }

  for (const player of players) {
    if (player.sportsdata_id) pushMap(maps.bySpDataId, player.sportsdata_id, player)
    if (!player.display_name) continue
    pushMap(maps.byExactName, player.display_name.toLowerCase(), player)
    pushMap(maps.byNormName, normalizeName(player.display_name), player)
  }

  return maps
}

function pushMap(map: Map<string, PlayerForRanking[]>, key: string, player: PlayerForRanking): void {
  const existing = map.get(key)
  if (existing) existing.push(player)
  else map.set(key, [player])
}

function findPlayerForRanking(ranking: RankingRow, maps: PlayerMaps): PlayerForRanking | null {
  if (isDraftPlaceholder(ranking)) return null

  if (ranking.sourcePlayerId) {
    const byId = pickBestCandidate(maps.bySpDataId.get(ranking.sourcePlayerId) ?? [], ranking)
    if (byId) return byId
  }

  const names = rankingLookupNames(ranking.name)
  for (const name of names) {
    const exact = pickBestCandidate(maps.byExactName.get(name.toLowerCase()) ?? [], ranking)
    if (exact) return exact
  }
  for (const name of names) {
    const normalized = pickBestCandidate(maps.byNormName.get(normalizeName(name)) ?? [], ranking)
    if (normalized) return normalized
  }

  return null
}

function rankingLookupNames(name: string): string[] {
  const aliases = HASHTAG_NAME_ALIASES[normalizeName(name)] ?? []
  return [name, ...aliases]
}

function pickBestCandidate(candidates: PlayerForRanking[], ranking: RankingRow): PlayerForRanking | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const rankingTeam = normalizeTeam(ranking.team)
  let narrowed = candidates
  if (rankingTeam && rankingTeam !== 'FA') {
    const teamMatches = candidates.filter((player) => normalizeTeam(player.nba_team) === rankingTeam)
    if (teamMatches.length === 1) return teamMatches[0]
    if (teamMatches.length > 1) narrowed = teamMatches
  }

  const scored = narrowed
    .map((player) => ({ player, score: playerScore(player, rankingTeam) }))
    .sort((a, b) => b.score - a.score)
  if (scored.length === 1 || scored[0].score > scored[1].score) return scored[0].player
  return null
}

function playerScore(player: PlayerForRanking, rankingTeam: string | null): number {
  let score = 0
  if (rankingTeam && rankingTeam !== 'FA' && normalizeTeam(player.nba_team) === rankingTeam) score += 100
  if (player.status && !['Inactive', 'RET', 'Retired'].includes(player.status)) score += 20
  if (player.sleeper_id) score += 10
  if (player.nba_id) score += 5
  if (player.sportsdata_id) score += 3
  return score
}

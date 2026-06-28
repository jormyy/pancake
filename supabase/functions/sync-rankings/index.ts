import { supabase } from '../_shared/supabase.ts'
import { normalizeName } from '../_shared/nameMatch.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'
import * as cheerio from 'npm:cheerio'
import type { AnyNode } from 'npm:domhandler'

const RANKINGS_URL = 'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings'
const RANKINGS_SOURCE = 'hashtagbasketball.com'
const CHUNK = 500

type RankingRow = { rank: number; name: string; team: string; siteId: string | null }
type PlayerForRanking = {
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
}

const TEAM_ALIASES: Record<string, string> = {
  BKN: 'BKN',
  GS: 'GS',
  GSW: 'GS',
  NO: 'NO',
  NOP: 'NO',
  NY: 'NY',
  NYK: 'NY',
  SA: 'SA',
  SAS: 'SA',
}

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    await syncDynastyRankings()
    return Response.json({ ok: true })
  } catch (e: unknown) {
    return internalServerError('sync-rankings', e)
  }
})

async function syncDynastyRankings() {
  console.log('[sync-rankings] Scraping dynasty rankings...')
  const rankings = await scrapeDynastyRankings()
  const fetchedAt = new Date().toISOString()
  console.log(`[sync-rankings] Scraped ${rankings.length} players.`)

  // Paginate to avoid PostgREST max_rows cap
  const players: PlayerForRanking[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('players')
      .select('id, display_name, sportsdata_id, sleeper_id, nba_id, nba_team, status')
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    players.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  const playerMaps = buildPlayerMaps(players)

  let matched = 0
  const updates: {
    id: string
    dynasty_rank: number
    dynasty_rank_source: string
    dynasty_rank_fetched_at: string
  }[] = []

  for (const r of rankings) {
    const player = findPlayerForRanking(r, playerMaps)

    if (player) {
      updates.push({
        id: player.id,
        dynasty_rank: r.rank,
        dynasty_rank_source: RANKINGS_SOURCE,
        dynasty_rank_fetched_at: fetchedAt,
      })
      matched++
    }
  }

  for (const update of updates) {
    const { error } = await supabase
      .from('players')
      .update({
        dynasty_rank: update.dynasty_rank,
        dynasty_rank_source: update.dynasty_rank_source,
        dynasty_rank_fetched_at: update.dynasty_rank_fetched_at,
      })
      .eq('id', update.id)
    if (error) throw error
  }

  // Clear dynasty_rank for players no longer on the list
  const rankedIds = new Set(updates.map((u) => u.id))
  const currentlyRanked: { id: string }[] = []
  let fromRanked = 0
  while (true) {
    const { data, error } = await supabase
      .from('players')
      .select('id')
      .not('dynasty_rank', 'is', null)
      .range(fromRanked, fromRanked + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    currentlyRanked.push(...data)
    if (data.length < PAGE) break
    fromRanked += PAGE
  }

  const toClear = currentlyRanked.filter((p) => !rankedIds.has(p.id)).map((p) => p.id)
  if (toClear.length > 0) {
    await supabase
      .from('players')
      .update({
        dynasty_rank: null,
        dynasty_rank_source: null,
        dynasty_rank_fetched_at: null,
      })
      .in('id', toClear)
  }

  console.log(`[sync-rankings] Matched ${matched}/${rankings.length} players.`)
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

  if (ranking.siteId) {
    const byId = pickBestCandidate(maps.bySpDataId.get(ranking.siteId) ?? [], ranking)
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

function isDraftPlaceholder(ranking: RankingRow): boolean {
  return normalizeTeam(ranking.team) === 'DRA' || /^\d{4}\s+draft\s+\(/i.test(ranking.name)
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

function normalizeTeam(team: string | null): string | null {
  if (!team) return null
  const upper = team.toUpperCase()
  return TEAM_ALIASES[upper] ?? upper
}

async function scrapeDynastyRankings(): Promise<RankingRow[]> {
  const res = await fetch(RANKINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PancakeApp/1.0)' },
  })
  if (!res.ok) throw new Error(`Rankings fetch ${res.status}`)
  const html = await res.text()
  const $ = cheerio.load(html)

  const rankings: Array<{ rank: number; name: string; team: string; siteId: string | null }> = []

  $('table.table--statistics tr').each((_: number, row: AnyNode) => {
    const cells = $(row).find('td.dynasty.d-none')
    if (cells.length < 5) return

    const rankText = $(cells[0]).find('span').first().text().replace('#', '').trim()
    const rank = parseInt(rankText)
    if (isNaN(rank)) return

    const name = $(cells[1])
      .contents()
      .filter((_: number, n: any) => n.type === 'text')
      .first()
      .text()
      .trim()
    const siteId = $(cells[1]).find('input[type="hidden"]').attr('value') ?? null
    const team = $(cells[3]).text().trim()

    if (name) rankings.push({ rank, name, team, siteId })
  })

  return dedupeRankings(rankings)
}

function dedupeRankings(rankings: RankingRow[]): RankingRow[] {
  const byKey = new Map<string, RankingRow>()
  for (const ranking of rankings) {
    const key = ranking.siteId
      ? `site:${ranking.siteId}`
      : `name:${normalizeName(ranking.name)}:${normalizeTeam(ranking.team) ?? ''}`
    const existing = byKey.get(key)
    if (!existing || ranking.rank < existing.rank) byKey.set(key, ranking)
  }
  return [...byKey.values()].sort((a, b) => a.rank - b.rank)
}

import { supabase } from '../_shared/supabase.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'
import { buildDynastyRankingPayload, RANKINGS_SOURCE, type PlayerForRanking } from './match.ts'
import { parseDynastyRankingsHtml, type RankingRow } from './parser.ts'

const RANKINGS_URL = 'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings'
const MIN_RANKING_ROWS = 500

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
  const [rankings, players] = await Promise.all([
    scrapeDynastyRankings(),
    fetchPlayersForRanking(),
  ])
  const fetchedAt = new Date().toISOString()
  console.log(`[sync-rankings] Scraped ${rankings.length} players.`)

  const { rows: rankingRows, matched } = buildDynastyRankingPayload(rankings, players, fetchedAt)
  if (rankingRows.length < MIN_RANKING_ROWS) {
    throw new Error(`Parsed ${rankingRows.length} ranking rows, below minimum ${MIN_RANKING_ROWS}`)
  }

  const { data: result, error } = await supabase.rpc('replace_dynasty_rankings', {
    p_source: RANKINGS_SOURCE,
    p_fetched_at: fetchedAt,
    p_rows: rankingRows,
    p_min_rows: MIN_RANKING_ROWS,
  })
  if (error) throw error

  console.log(`[sync-rankings] Stored ${rankingRows.length} ranking rows; matched ${matched}/${rankingRows.length} players.`, result)
}

async function fetchPlayersForRanking(): Promise<PlayerForRanking[]> {
  const players: PlayerForRanking[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('players')
      .select('id, display_name, sportsdata_id, sleeper_id, nba_id, nba_team, status')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    players.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return players
}

async function scrapeDynastyRankings(): Promise<RankingRow[]> {
  const res = await fetch(RANKINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PancakeApp/1.0)' },
  })
  if (!res.ok) throw new Error(`Rankings fetch ${res.status}`)
  return parseDynastyRankingsHtml(await res.text())
}

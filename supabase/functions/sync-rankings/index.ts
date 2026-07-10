import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import { buildDynastyRankingPayload, RANKINGS_SOURCE, type PlayerForRanking } from './match.ts'
import { parseDynastyRankingsHtml, selectedDynastyRankingType, type RankingRow } from './parser.ts'
import * as cheerio from 'npm:cheerio@1.2.0'

const RANKINGS_URL = 'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings'
const POINTS_RANKING_TYPE = 'POINT'
const MIN_RANKING_ROWS = 500

serveInternal('sync-rankings', async () => {
  const rows = await recordSyncRun('sync-rankings', async () => {
    const rows = await syncDynastyRankings()
    return { result: rows, rowsAffected: rows }
  })
  return Response.json({ ok: true, rows })
})

async function syncDynastyRankings(): Promise<number> {
  console.log('[sync-rankings] Scraping dynasty rankings...')
  const [scraped, players] = await Promise.all([scrapeDynastyRankings(), fetchPlayersForRanking()])
  const fetchedAt = new Date().toISOString()
  console.log(`[sync-rankings] Scraped ${scraped.rankings.length} ${scraped.scoringFormat} rows.`)

  const { rows: rankingRows, matched } = buildDynastyRankingPayload(scraped.rankings, players, fetchedAt)
  if (rankingRows.length < MIN_RANKING_ROWS) {
    throw new Error(`Parsed ${rankingRows.length} ranking rows, below minimum ${MIN_RANKING_ROWS}`)
  }

  const { data: result, error } = await supabase.rpc('replace_dynasty_rankings', {
    p_source: RANKINGS_SOURCE,
    p_fetched_at: fetchedAt,
    p_rows: rankingRows,
    p_min_rows: MIN_RANKING_ROWS,
    p_scoring_format: scraped.scoringFormat,
    p_source_url: RANKINGS_URL,
    p_source_metadata: scraped.metadata,
  })
  if (error) throw error

  console.log(`[sync-rankings] Stored ${rankingRows.length} ranking rows; matched ${matched}/${rankingRows.length} players.`, result)
  return rankingRows.length
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

type ScrapedRankings = {
  rankings: RankingRow[]
  scoringFormat: 'points' | 'overall'
  metadata: Record<string, string | number | boolean | null>
}

async function scrapeDynastyRankings(): Promise<ScrapedRankings> {
  const pointsHtml = await fetchPointsRankingsHtml()
  const selectedType = selectedDynastyRankingType(pointsHtml)
  if (selectedType === POINTS_RANKING_TYPE) {
    return {
      rankings: parseDynastyRankingsHtml(pointsHtml),
      scoringFormat: 'points',
      metadata: {
        requestedRankingType: POINTS_RANKING_TYPE,
        selectedRankingType: selectedType,
        requestMethod: 'POST',
        forecastSeasons: 5,
      },
    }
  }

  console.warn(`[sync-rankings] Points rankings unavailable; selected type was ${selectedType ?? 'unknown'}. Falling back to overall rankings.`)
  const fallbackHtml = await fetchRankingsHtml()
  return {
    rankings: parseDynastyRankingsHtml(fallbackHtml),
    scoringFormat: 'overall',
    metadata: {
      requestedRankingType: POINTS_RANKING_TYPE,
      selectedRankingType: selectedType,
      requestMethod: 'GET',
      forecastSeasons: 5,
      fallbackReason: 'Hashtag did not return the requested points-league ranking type.',
    },
  }
}

async function fetchRankingsHtml(): Promise<string> {
  const res = await fetchWithRetry(RANKINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PancakeApp/1.0)' },
  })
  if (!res.ok) throw new Error(`Rankings fetch ${res.status}`)
  return res.text()
}

async function fetchPointsRankingsHtml(): Promise<string> {
  const html = await fetchRankingsHtml()
  const form = buildAspNetRankingForm(html)
  form.set('ctl00$ContentPlaceHolder1$DDTYPE', POINTS_RANKING_TYPE)

  const res = await fetchWithRetry(RANKINGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://hashtagbasketball.com',
      'Referer': RANKINGS_URL,
      'User-Agent': 'Mozilla/5.0 (compatible; PancakeApp/1.0)',
    },
    body: form,
  })
  if (!res.ok) throw new Error(`Points rankings fetch ${res.status}`)
  return res.text()
}

function buildAspNetRankingForm(html: string): URLSearchParams {
  const $ = cheerio.load(html)
  const form = new URLSearchParams()
  $('input[name]').each((_, input) => {
    const name = $(input).attr('name')
    if (name) form.set(name, $(input).attr('value') ?? '')
  })
  $('select[name]').each((_, select) => {
    const name = $(select).attr('name')
    const value = $(select).find('option[selected]').attr('value') ?? $(select).find('option').first().attr('value') ?? ''
    if (name) form.set(name, value)
  })
  return form
}

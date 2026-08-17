import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import { buildDynastyRankingPayload, type PlayerForRanking } from './match.ts'
import { parseDynastyRankingOrderHtml, parseDynastyRankingsHtml, selectedDynastyRankingType } from './parser.ts'
import { RANKING_VIEWS_IN_WRITE_ORDER, type RankingViewDefinition } from './views.ts'
import * as cheerio from 'npm:cheerio@1.2.0'

const RANKINGS_URL = 'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings'

serveInternal('sync-rankings', async (req) => {
  const requestedView = await requestedRankingView(req) ?? RANKING_VIEWS_IN_WRITE_ORDER.at(-1)!

  const rows = await recordSyncRun('sync-rankings', async () => {
    const rows = await syncRankingView(requestedView)
    return { result: rows, rowsAffected: rows }
  })
  return Response.json({ ok: true, rows, view: requestedView.type })
})

async function syncRankingView(view: RankingViewDefinition): Promise<number> {
  console.log(`[sync-rankings] Scraping published ${view.type} rankings...`)
  const [baseHtml, players] = await Promise.all([fetchRankingsHtml(), fetchPlayersForRanking()])
  const fetchedAt = new Date().toISOString()
  const html = view.type === 'OVERALL' ? baseHtml : await fetchRankingViewHtml(baseHtml, view.type)
  const rankings = view.type === 'OVERALL'
    ? parseDynastyRankingsHtml(html)
    : parseDynastyRankingOrderHtml(html)
  if (rankings.length < view.minimumRows) {
    throw new Error(`Parsed ${rankings.length} ${view.type} rows, below minimum ${view.minimumRows}`)
  }
  const payload = buildDynastyRankingPayload(rankings, players, fetchedAt, view.source)
  const result = await replaceRankingView(view, payload.rows, payload.matched, fetchedAt)
  console.log(
    `[sync-rankings] Stored ${payload.rows.length} ${view.type} rows; matched ${payload.matched}/${payload.rows.length} players.`,
    result,
  )
  return payload.rows.length
}

async function requestedRankingView(req: Request): Promise<RankingViewDefinition | null> {
  const body = await req.clone().json().catch(() => null) as { view?: unknown } | null
  if (!body || body.view == null) return null
  if (typeof body.view !== 'string') throw new Error('Ranking view must be a string')
  const requested = body.view.trim().toUpperCase()
  const view = RANKING_VIEWS_IN_WRITE_ORDER.find((candidate) => candidate.type === requested)
  if (!view) throw new Error(`Unknown ranking view: ${body.view}`)
  return view
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

async function fetchRankingsHtml(): Promise<string> {
  const res = await fetchWithRetry(RANKINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PancakeApp/1.0)' },
  })
  if (!res.ok) throw new Error(`Rankings fetch ${res.status}`)
  return res.text()
}

async function fetchRankingViewHtml(html: string, rankingType: RankingViewDefinition['type']): Promise<string> {
  const form = buildAspNetRankingForm(html)
  form.set('ctl00$ContentPlaceHolder1$DDTYPE', rankingType)

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
  if (!res.ok) throw new Error(`${rankingType} rankings fetch ${res.status}`)
  const responseHtml = await res.text()
  const selectedType = selectedDynastyRankingType(responseHtml)
  if (selectedType !== rankingType) {
    throw new Error(`Requested ${rankingType} rankings but Hashtag selected ${selectedType ?? 'unknown'}`)
  }
  return responseHtml
}

async function replaceRankingView(
  view: RankingViewDefinition,
  rows: ReturnType<typeof buildDynastyRankingPayload>['rows'],
  matched: number,
  fetchedAt: string,
) {
  const { data, error } = await supabase.rpc('replace_dynasty_rankings', {
    p_source: view.source,
    p_fetched_at: fetchedAt,
    p_rows: rows,
    p_min_rows: view.minimumRows,
    p_scoring_format: 'overall',
    p_source_url: RANKINGS_URL,
    p_source_metadata: {
      requestedRankingType: view.type,
      selectedRankingType: view.type,
      requestMethod: view.type === 'OVERALL' ? 'GET' : 'POST',
      forecastSeasons: 5,
      matchedPlayers: matched,
    },
  })
  if (error) throw error
  return data
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

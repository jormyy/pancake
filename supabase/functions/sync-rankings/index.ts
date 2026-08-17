import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import { buildDynastyRankingPayload, type PlayerForRanking } from './match.ts'
import { buildAspNetRankingForm } from './form.ts'
import { parseDynastyRankingOrderHtml, parseDynastyRankingsHtml } from './parser.ts'
import { RANKING_VIEWS_IN_WRITE_ORDER, rankingViewForRequest, type RankingViewDefinition } from './views.ts'

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
  const fetchedAt = new Date().toISOString()
  const rankings = await fetchRankingView(view)
  if (rankings.length < view.minimumRows) {
    throw new Error(`Parsed ${rankings.length} ${view.type} rows, below minimum ${view.minimumRows}`)
  }
  const players = await fetchPlayersForRanking()
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
  const view = rankingViewForRequest(requested)
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

async function fetchRankingForm(): Promise<URLSearchParams> {
  const res = await fetchWithRetry(RANKINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PancakeApp/1.0)' },
  })
  if (!res.ok) throw new Error(`Rankings fetch ${res.status}`)
  return buildAspNetRankingForm(await res.text())
}

async function fetchRankingView(view: RankingViewDefinition) {
  const form = await fetchRankingForm()
  form.set('ctl00$ContentPlaceHolder1$DDTYPE', view.hashtagType)
  form.set('ctl00$ContentPlaceHolder1$DDFORECAST', String(view.forecastSeasons))

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
  if (!res.ok) throw new Error(`${view.type} rankings fetch ${res.status}`)
  const responseHtml = await res.text()
  const responseForm = buildAspNetRankingForm(responseHtml)
  const selectedType = responseForm.get('ctl00$ContentPlaceHolder1$DDTYPE')
  const selectedForecast = Number(responseForm.get('ctl00$ContentPlaceHolder1$DDFORECAST'))
  if (selectedType !== view.hashtagType || selectedForecast !== view.forecastSeasons) {
    throw new Error(
      `Requested ${view.hashtagType}/${view.forecastSeasons} but Hashtag selected ${selectedType ?? 'unknown'}/${selectedForecast ?? 'unknown'}`,
    )
  }
  return view.hashtagType === 'POINT'
    ? parseDynastyRankingsHtml(responseHtml)
    : parseDynastyRankingOrderHtml(responseHtml)
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
    p_scoring_format: view.hashtagType === 'POINT' ? 'points' : 'overall',
    p_source_url: RANKINGS_URL,
    p_source_metadata: {
      requestedRankingType: view.type,
      selectedRankingType: view.hashtagType,
      requestMethod: 'POST',
      forecastSeasons: view.forecastSeasons,
      matchedPlayers: matched,
    },
  })
  if (error) throw error
  return data
}

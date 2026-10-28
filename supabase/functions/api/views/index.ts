import { withGameTimes } from './game-times.ts'
import { otherMatchupView } from './other-matchup.ts'
import { assertUuid, json, NotFoundError, requireUser, throwDb } from '../../_shared/apiRuntime.ts'
import { screenViews, viewClient, viewRequest, type ScreenView } from '../../_shared/views.ts'
import { createTradeEstimate } from '../tradeEstimates.ts'

export async function handleViewRoute(request: Request, path: string): Promise<Response | null> {
  if (request.method !== 'GET' || !path.startsWith('/views/')) return null
  const screen = path.slice('/views/'.length)
  if (!Object.hasOwn(screenViews, screen)) return null
  const name = screen as ScreenView
  const args = viewRequest(new URL(request.url), name)
  const userId = await requireUser(request)
  const client = viewClient(request)
  if (name === 'trade-analysis' && typeof args.p_params === 'object' && args.p_params && !Array.isArray(args.p_params)
    && args.p_params.items && !args.p_params.tradeId) {
    const { data: context, error } = await client.rpc('view_context', args)
    if (error) throwDb(error)
    const quote = await createTradeEstimate(userId, args.p_member_id, args.p_params.items)
    return json({ ok: true, view: { context, quote, analysis: quote.analysis } })
  }
  const completeHome = (view: Record<string, unknown>) => withGameTimes(view, async ids => {
    const result = await client.from('nba_games').select('id,game_time').in('id', ids)
    if (result.error) throwDb(result.error)
    return result.data ?? []
  })
  const { data, error } = await client.rpc(screenViews[name], args)
  if (error) throwDb(error)
  if (name === 'home' && args.p_params && typeof args.p_params === 'object' && !Array.isArray(args.p_params) && args.p_params.matchupId !== undefined) {
    assertUuid(String(args.p_params.matchupId), 'matchupId')
    const view = await otherMatchupView(data as Record<string, unknown>, String(args.p_params.matchupId), async (resource, params) => {
      if (resource === 'matchup') {
        const result = await client.from('matchups').select('week_number,end_week_number,winner_member_id')
          .eq('id', String(params.id)).eq('league_id', args.p_league_id).eq('is_voided', false).single()
        if (result.error) throwDb(result.error)
        return result.data
      }
      if (resource === 'forecast') {
        const result = await client.rpc('get_matchup_forecast', { p_matchup_id: String(params.p_matchup_id) })
        if (result.error) throwDb(result.error)
        return result.data
      }
      const result = await client.rpc(resource === 'lineup' ? 'view_lineup' : 'view_standings', {
        ...args, p_params: { ...args.p_params as Record<string, never>, ...params } as typeof args.p_params,
      })
      if (result.error) throwDb(result.error)
      return result.data
    })
    if (!view) throw new NotFoundError('This matchup is not available this week.')
    return json({ ok: true, view: await completeHome(view) })
  }
  return json({ ok: true, view: name === 'home' ? await completeHome(data as Record<string, unknown>) : data })
}

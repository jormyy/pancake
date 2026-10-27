import { json, requireUser, throwDb } from '../../_shared/apiRuntime.ts'
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
  const { data, error } = await client.rpc(screenViews[name], args)
  if (error) throwDb(error)
  return json({ ok: true, view: data })
}

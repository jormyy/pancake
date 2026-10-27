import { json, requireUser, throwDb, uuidField, ValidationError } from '../../_shared/apiRuntime.ts'
import { supabase } from '../../_shared/supabase.ts'

export async function handleVersionRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'GET' || path !== '/version') return null
  const params = new URL(req.url).searchParams
  const leagueId = uuidField({ league: params.get('league') }, 'league')
  const since = params.get('since') ?? '0'
  if (!/^(0|[1-9]\d{0,18})$/.test(since) || BigInt(since) > 9223372036854775807n) {
    throw new ValidationError('since must be a nonnegative bigint')
  }
  const userId = await requireUser(req)
  const { data, error } = await supabase.rpc('get_league_version', {
    p_league_id: leagueId,
    p_user_id: userId,
    p_since: since,
  })
  if (error) throwDb(error)
  const response = json(data)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

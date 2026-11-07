import { supabase } from '../../_shared/supabase.ts'
import { createPublicHandler, type PublicRead } from './handler.ts'

type Client = { rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: Awaited<ReturnType<PublicRead>>; error: unknown }> }
export const handlePublicRoute = createPublicHandler(async (league, resource, params, clientKey) => {
  const result = await (supabase as unknown as Client).rpc('public_read_v2', { p_league_id: league, p_resource: resource, p_params: params, p_client_key: clientKey })
  if (result.error) throw new Error('Public read failed')
  return result.data
})

import { supabase } from '../../_shared/supabase.ts'
import { createPublicHandler, type PublicRead } from './handler.ts'

type Client = { rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: Awaited<ReturnType<PublicRead>>; error: unknown }> }
export const handlePublicRoute = createPublicHandler(async (token, resource, params) => {
  const result = await (supabase as unknown as Client).rpc('public_read', { p_token: token, p_resource: resource, p_params: params })
  if (result.error) throw new Error('Public read failed')
  return result.data
})

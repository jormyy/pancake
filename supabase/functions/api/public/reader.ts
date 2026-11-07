import type { PublicRead } from './handler.ts'

type Result = Awaited<ReturnType<PublicRead>>
type Client = { rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: Result; error: unknown }> }

export function createPublicReader(client: Client): PublicRead {
  return async (league, resource, params, clientKey) => {
    const admission = await client.rpc('public_admit_read', { p_client_key: clientKey })
    if (admission.error) throw new Error('Public admission failed')
    if (admission.data.status !== 200) return admission.data
    const result = await client.rpc('public_read_v2', { p_league_id: league, p_resource: resource, p_params: params, p_client_key: clientKey })
    if (result.error) throw new Error('Public read failed')
    return result.data
  }
}

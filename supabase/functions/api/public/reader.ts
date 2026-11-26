import type { PublicAdmit, PublicRead, PublicSource } from './handler.ts'

type Client = { rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> }

export function createPublicReader(client: Client): PublicSource {
  const admit: PublicAdmit = async clientKey => {
    const admission = await client.rpc('public_admit_read', { p_client_key: clientKey })
    if (admission.error) throw new Error('Public admission failed')
    return admission.data as Awaited<ReturnType<PublicAdmit>>
  }
  const read: PublicRead = async (league, resource, params, clientKey) => {
    const result = await client.rpc('public_read_v2', { p_league_id: league, p_resource: resource, p_params: params, p_client_key: clientKey })
    if (result.error) throw new Error('Public read failed')
    return result.data as Awaited<ReturnType<PublicRead>>
  }
  return { admit, read }
}

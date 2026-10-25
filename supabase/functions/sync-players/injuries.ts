import { supabase } from '../_shared/supabase.ts'
import { fetchEspnInjuries } from '../_shared/playerSource.ts'
import { normalizeName } from '../_shared/nameMatch.ts'
import { errorMessage } from '../_shared/responses.ts'
import { fetchAllPlayers } from './players.ts'

export async function isInjuriesOnlyRequest(request: Request): Promise<boolean> {
  const body = await request.clone().json().catch(() => null)
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 1 && body.mode === 'injuries'
}

export async function syncInjuries(): Promise<{ updated: number; failure: string | null }> {
  const { statuses, failure } = await fetchEspnInjuries()
  if (!statuses) return { updated: 0, failure }
  const players = await fetchAllPlayers<{
    id: string; display_name: string; espn_id: string | null; injury_status: string | null
  }>(supabase, 'id, display_name, espn_id, injury_status')
  const counts = new Map<string, number>()
  for (const player of players) {
    const name = normalizeName(player.display_name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  let updated = 0
  const failures: string[] = []
  for (const player of players) {
    const name = normalizeName(player.display_name)
    if (counts.get(name) !== 1) continue
    const status = statuses.get(name) ?? null
    if (status === player.injury_status) continue
    let query = supabase.from('players').update({ injury_status: status })
      .eq('id', player.id).eq('display_name', player.display_name)
    query = player.espn_id ? query.eq('espn_id', player.espn_id) : query.is('espn_id', null)
    query = player.injury_status === null ? query.is('injury_status', null) : query.eq('injury_status', player.injury_status)
    const { data, error } = await query.select('id')
    if (error) failures.push(`${player.id}: ${errorMessage(error)}`)
    else updated += data?.length ?? 0
  }
  return { updated, failure: failures.length > 0 ? `Injuries refresh: ${failures.join('; ')}` : null }
}

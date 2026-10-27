import { supabase } from '../_shared/supabase.ts'
import { fetchEspnInjuries } from '../_shared/playerSource.ts'
import { normalizeName } from '../_shared/nameMatch.ts'
import { errorMessage } from '../_shared/responses.ts'
import { fetchAllPlayers } from './players.ts'
import { linkPlayerSources } from '../_shared/sourceLinks.ts'

export async function syncInjuries(): Promise<{ updated: number; failure: string | null }> {
  const { statuses, byId, identities, detailsById, detailsByName, failure } = await fetchEspnInjuries()
  if (!statuses) return { updated: 0, failure }
  if (identities.length) await linkPlayerSources(supabase, 'espn', [...new Map(identities.map(row => [row.provider_id, row])).values()])
  const rows = await fetchAllPlayers<{
    id: string; display_name: string; espn_id: string | null; nba_team: string | null; injury_status: string | null; injury_reason: string; injury_expected_return: string
  }>(supabase, 'id, display_name, espn_id, nba_team, injury_status, injury_reason, injury_expected_return')
  const players = rows.filter(player => player.espn_id !== null && player.nba_team !== null)
  const counts = new Map<string, number>()
  for (const player of players) {
    const name = normalizeName(player.display_name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  let updated = 0
  const failures: string[] = []
  for (const player of players) {
    const name = normalizeName(player.display_name)
    if (!byId.has(player.espn_id!) && counts.get(name) !== 1) continue
    const status = byId.get(player.espn_id!) ?? statuses.get(name) ?? null
    const details = detailsById.get(player.espn_id!) ?? (counts.get(name) === 1 ? detailsByName.get(name) : undefined) ?? { injury_reason: 'unknown', injury_expected_return: 'unknown' }
    if (status === player.injury_status && details.injury_reason === player.injury_reason && details.injury_expected_return === player.injury_expected_return) continue
    let query = supabase.from('players').update({ injury_status: status, ...details })
      .eq('id', player.id).eq('display_name', player.display_name)
      .eq('espn_id', player.espn_id!).eq('nba_team', player.nba_team!)
      .eq('injury_reason', player.injury_reason).eq('injury_expected_return', player.injury_expected_return)
    query = player.injury_status === null ? query.is('injury_status', null) : query.eq('injury_status', player.injury_status)
    const { data, error } = await query.select('id')
    if (error) failures.push(`${player.id}: ${errorMessage(error)}`)
    else updated += data?.length ?? 0
  }
  return { updated, failure: failures.length > 0 ? `Injuries refresh: ${failures.join('; ')}` : null }
}

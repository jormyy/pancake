import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { linkPlayerSources, type SourceLinkRecord } from '../_shared/sourceLinks.ts'
import { mapEspnTeam } from '../_shared/playerSource.ts'
import { errorMessage } from '../_shared/responses.ts'
import { fetchAllPlayers } from './players.ts'

const SLEEPER_URL = `${Deno.env.get('SLEEPER_BASE_URL') ?? 'https://api.sleeper.app/v1'}/players/nba`

export async function syncSleeperLinks(): Promise<{ linked: number; failures: string[] }> {
  const players = await fetchAllPlayers<{ id: string; nba_team: string | null; sleeper_id: string | null; years_exp: number | null; position: string | null }>(
    supabase, 'id, nba_team, sleeper_id, years_exp, position')
  if (!players.some(row => row.nba_team && (row.sleeper_id == null || row.years_exp == null || row.position == null))) return { linked: 0, failures: [] }
  try {
    const response = await fetchWithRetry(SLEEPER_URL, { signal: AbortSignal.timeout(8000) }, { attemptTimeoutMs: 4000 })
    if (!response.ok) throw new Error(`Sleeper players ${response.status}`)
    const data = await response.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Sleeper player list')
    const records: SourceLinkRecord[] = []
    for (const row of Object.values(data) as Record<string, unknown>[]) {
      if (!row || row.sport !== 'nba' || typeof row.player_id !== 'string' || !/^\d+$/.test(row.player_id)
        || typeof row.team !== 'string' || !row.team || typeof row.first_name !== 'string' || typeof row.last_name !== 'string') continue
      const position = typeof row.position === 'string' && ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'].includes(row.position) ? row.position : null
      records.push({ provider_id: row.player_id, display_name: `${row.first_name} ${row.last_name}`,
        nba_team: mapEspnTeam(row.team)!, position,
        years_exp: typeof row.years_exp === 'number' && Number.isInteger(row.years_exp) && row.years_exp >= 0 ? row.years_exp : null })
    }
    if (!records.length) throw new Error('Sleeper player list has no NBA identities')
    const linked = await linkPlayerSources(supabase, 'sleeper', records)
    return { linked: linked.filter(row => row.action === 'updated').length,
      failures: linked.filter(row => row.action === 'ambiguous').map(row => `Sleeper player ${records[row.index].provider_id}: ambiguous`) }
  } catch (error) { return { linked: 0, failures: [`Sleeper identities: ${errorMessage(error)}`] } }
}

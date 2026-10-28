import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { linkPlayerSources, type SourceLinkRecord } from '../_shared/sourceLinks.ts'
import { mapEspnTeam } from '../_shared/playerSource.ts'
import { errorMessage } from '../_shared/responses.ts'
import { fetchAllPlayers } from './players.ts'
import { syncProfileBirthdates, syncSourceBirthdates, type BirthdatePlayer } from './birthdates.ts'

const SLEEPER_URL = `${Deno.env.get('SLEEPER_BASE_URL') ?? 'https://api.sleeper.app/v1'}/players/nba`

export async function syncSleeperLinks(budgetMs = 60000): Promise<{ linked: number; birthdatesUpdated: number; deferred: boolean; failures: string[] }> {
  const started = performance.now()
  const players = await fetchAllPlayers<BirthdatePlayer & { nba_team: string | null; years_exp: number | null; position: string | null }>(
    supabase, 'id, display_name, nba_team, sleeper_id, espn_id, nba_id, birthdate, years_exp, position')
  const needsLinks = players.some(row => row.nba_team && (row.sleeper_id == null || row.years_exp == null || row.position == null))
  if (!needsLinks && !players.some(row => (row.sleeper_id || row.nba_id || row.espn_id) && row.birthdate === null)) return { linked: 0, birthdatesUpdated: 0, deferred: false, failures: [] }
  try {
    const response = await fetchWithRetry(SLEEPER_URL, { signal: AbortSignal.timeout(8000) }, { attemptTimeoutMs: 4000 })
    if (response.status === 503) {
      await response.body?.cancel()
      return { linked: 0, birthdatesUpdated: 0, deferred: true, failures: [] }
    }
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
    const linked: { index: number; player_id: string | null; action: string }[] = []
    if (needsLinks) {
      for (let offset = 0; offset < records.length; offset += 50) {
        const batch = await linkPlayerSources(supabase, 'sleeper', records.slice(offset, offset + 50))
        linked.push(...batch.map(row => ({ ...row, index: offset + row.index })))
      }
    }
    const current = needsLinks ? await fetchAllPlayers<BirthdatePlayer>(supabase, 'id, display_name, sleeper_id, espn_id, nba_id, birthdate') : players
    const birthdates = await syncSourceBirthdates(current, Object.values(data), Math.max(0, Math.min(60000, budgetMs) - (performance.now() - started)))
    const profiles = await syncProfileBirthdates(current, Math.max(0, Math.min(60000, budgetMs) - (performance.now() - started)))
    return { linked: linked.filter(row => row.action === 'updated').length, birthdatesUpdated: birthdates.updated + profiles.updated, deferred: false,
      failures: [...linked.filter(row => row.action === 'ambiguous').map(row => `Sleeper player ${records[row.index].provider_id}: ambiguous`), ...birthdates.failures, ...profiles.failures] }
  } catch (error) { return { linked: 0, birthdatesUpdated: 0, deferred: false, failures: [`Sleeper identities: ${errorMessage(error)}`] } }
}

import { supabase } from '../_shared/supabase.ts'
import { fetchEspnInjuries } from '../_shared/playerSource.ts'
import { normalizeName } from '../_shared/nameMatch.ts'
import { errorMessage, logInternalError } from '../_shared/responses.ts'
import { fetchAllPlayers } from './players.ts'
import { renewCurrentWorkLease } from '../_shared/workContext.ts'
import { linkPlayerSources } from '../_shared/sourceLinks.ts'
import { retryDatabaseContention } from '../_shared/databaseRetry.ts'

export async function syncInjuries(): Promise<{ updated: number; failure: string | null }> {
  const { statuses, byId, identities, detailsById, detailsByName, failure } = await fetchEspnInjuries()
  if (!statuses) return { updated: 0, failure }
  let renewAfter = -Infinity
  for (const identity of new Map(identities.map(row => [row.provider_id, row])).values()) {
    if (Date.now() >= renewAfter) {
      await renewCurrentWorkLease()
      renewAfter = Date.now() + 120_000
    }
    await retryDatabaseContention(() => linkPlayerSources(supabase, 'espn', [identity]))
  }
  const rows = await fetchAllPlayers<{
    id: string; display_name: string; espn_id: string | null; nba_team: string | null; injury_status: string | null; injury_reason: string; injury_expected_return: string
  }>(supabase, 'id, display_name, espn_id, nba_team, injury_status, injury_reason, injury_expected_return')
  const players = rows.filter(player => player.espn_id !== null && player.nba_team !== null).sort((a, b) => a.id.localeCompare(b.id))
  const counts = new Map<string, number>()
  for (const player of players) {
    const name = normalizeName(player.display_name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  await renewCurrentWorkLease()
  const writeDeadline = performance.now() + 5000
  let updated = 0
  const failures: string[] = []
  for (const player of players) {
    const name = normalizeName(player.display_name)
    if (!byId.has(player.espn_id!) && counts.get(name) !== 1) continue
    const status = byId.get(player.espn_id!) ?? statuses.get(name) ?? null
    const details = detailsById.get(player.espn_id!) ?? (counts.get(name) === 1 ? detailsByName.get(name) : undefined) ?? { injury_reason: 'unknown', injury_expected_return: 'unknown' }
    if (status === player.injury_status && details.injury_reason === player.injury_reason && details.injury_expected_return === player.injury_expected_return) continue
    if (performance.now() >= writeDeadline) {
      failures.push(`${player.id}: injury write budget exhausted`)
      continue
    }
    const save = () => {
      let query = supabase.from('players').update({ injury_status: status, ...details })
        .eq('id', player.id).eq('display_name', player.display_name)
        .eq('espn_id', player.espn_id!).eq('nba_team', player.nba_team!)
        .eq('injury_reason', player.injury_reason).eq('injury_expected_return', player.injury_expected_return)
      query = player.injury_status === null ? query.is('injury_status', null) : query.eq('injury_status', player.injury_status)
      return query.select('id')
    }
    const result = await retryDatabaseContention(save, {
      failures: result => result.error ? [result.error] : [], deadline: writeDeadline,
      onRetry: (error, attempt) => logInternalError(`sync-player-injuries: retry ${attempt}`, error),
    })
    const { data, error } = result
    if (error) failures.push(`${player.id}: ${errorMessage(error)}`)
    else updated += data?.length ?? 0
  }
  return { updated, failure: failures.length > 0 ? `Injuries refresh: ${failures.join('; ')}` : null }
}

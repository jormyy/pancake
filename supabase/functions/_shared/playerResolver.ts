import { supabase } from './supabase.ts'
import { normalizeName } from './nameMatch.ts'
import { mustSupabase } from './backfillJobs.ts'
import { resolvePlayerImports } from './playerImports.ts'

type PlayerRow = {
  id: string
  display_name: string | null
  nba_id?: string | null
}

const AMBIGUOUS = '__ambiguous__'

export type CdnPlayerResolver = {
  byNbaId: Map<string, string>
  byExactName: Map<string, string>
  byName: Map<string, string>
}

export type NamePlayerResolver = {
  byExactName: Map<string, string>
  byName: Map<string, string>
}

async function loadPlayers(select: string): Promise<PlayerRow[]> {
  const players: PlayerRow[] = []
  let page = 0
  while (true) {
    const rows = await mustSupabase(
      'load players for backfill resolver',
      supabase
        .from('players')
        .select(select)
        .range(page * 1000, (page + 1) * 1000 - 1),
    )
    if (!rows?.length) break
    players.push(...rows as unknown as PlayerRow[])
    if (rows.length < 1000) break
    page++
  }
  return players
}

export async function loadCdnPlayerResolver(): Promise<CdnPlayerResolver> {
  const byNbaId = new Map<string, string>()
  const byExactName = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const player of await loadPlayers('id, display_name, nba_id')) {
    if (player.nba_id) byNbaId.set(player.nba_id, player.id)
    if (player.display_name) {
      setUniqueName(byExactName, player.display_name.toLowerCase(), player.id)
      setUniqueName(byName, normalizeName(player.display_name), player.id)
    }
  }
  return { byNbaId, byExactName, byName }
}

export async function loadNamePlayerResolver(): Promise<NamePlayerResolver> {
  const byExactName = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const player of await loadPlayers('id, display_name')) {
    if (player.display_name) {
      setUniqueName(byExactName, player.display_name.toLowerCase(), player.id)
      setUniqueName(byName, normalizeName(player.display_name), player.id)
    }
  }
  return { byExactName, byName }
}

export async function resolveCdnPlayer(
  resolver: CdnPlayerResolver,
  personId: string,
  displayName: string,
): Promise<string | null> {
  // Cached names are hints only. A merge or another provider can change the
  // canonical UUID after this resolver loads.
  const { results } = await resolvePlayerImports('nba_cdn', [{ provider_id: personId, display_name: displayName }])
  const playerId = results[0].player_id
  if (!playerId) throw new Error(`Ambiguous CDN player name without NBA id: ${displayName}`)
  resolver.byNbaId.set(personId, playerId)
  setUniqueName(resolver.byExactName, displayName.toLowerCase(), playerId)
  setUniqueName(resolver.byName, normalizeName(displayName), playerId)
  return playerId
}

export async function resolveNamedPlayer(
  resolver: NamePlayerResolver,
  displayName: string,
): Promise<string | null> {
  const normalized = normalizeName(displayName)
  const exact = resolver.byExactName.get(displayName.toLowerCase())
  if (exact && exact !== AMBIGUOUS) return exact

  const existing = resolver.byName.get(normalized)
  if (existing && existing !== AMBIGUOUS) return existing

  if (exact === AMBIGUOUS || existing === AMBIGUOUS) {
    throw new Error(`Ambiguous BBRef player name: ${displayName}`)
  }

  throw new Error(`No canonical player match for BBRef player: ${displayName}`)
}

function setUniqueName(map: Map<string, string>, key: string, playerId: string): void {
  const existing = map.get(key)
  if (!existing) {
    map.set(key, playerId)
  } else if (existing !== playerId) {
    map.set(key, AMBIGUOUS)
  }
}

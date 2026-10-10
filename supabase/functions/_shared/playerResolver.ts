import { supabase } from './supabase.ts'
import { normalizeName } from './nameMatch.ts'
import { mustSupabase } from './backfillJobs.ts'

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
  const existingById = resolver.byNbaId.get(personId)
  if (existingById) return existingById

  const normalizedName = normalizeName(displayName)
  const exactName = resolver.byExactName.get(displayName.toLowerCase())
  if (exactName && exactName !== AMBIGUOUS) {
    await claimNbaId(exactName, personId)
    resolver.byNbaId.set(personId, exactName)
    return exactName
  }

  const normalizedMatch = resolver.byName.get(normalizedName)
  if (exactName === AMBIGUOUS || normalizedMatch === AMBIGUOUS) {
    throw new Error(`Ambiguous CDN player name without NBA id: ${displayName}`)
  }
  const existingByName = exactName && exactName !== AMBIGUOUS
    ? exactName
    : normalizedMatch
  if (existingByName && existingByName !== AMBIGUOUS) {
    await claimNbaId(existingByName, personId)
    resolver.byNbaId.set(personId, existingByName)
    return existingByName
  }

  const playerId = await createPlayer(displayName, personId)
  if (!playerId) return null

  resolver.byNbaId.set(personId, playerId)
  setUniqueName(resolver.byExactName, displayName.toLowerCase(), playerId)
  setUniqueName(resolver.byName, normalizedName, playerId)
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

async function claimNbaId(playerId: string, nbaId: string): Promise<void> {
  // Claim identity before returning a player ID that callers use for stats.
  // The null predicate prevents concurrent providers from replacing an ID.
  const claimed = await mustSupabase(
    'claim NBA player id',
    supabase.from('players').update({ nba_id: nbaId })
      .eq('id', playerId).is('nba_id', null).select('id').maybeSingle(),
  )
  if (claimed?.id) return

  const current = await mustSupabase(
    'verify NBA player id',
    supabase.from('players').select('nba_id').eq('id', playerId).maybeSingle(),
  )
  if (current?.nba_id !== nbaId) {
    throw new Error(`Conflicting NBA identity for player ${playerId}: ${nbaId}`)
  }
}

async function createPlayer(displayName: string, nbaId?: string): Promise<string | null> {
  if (!nbaId) throw new Error(`Cannot create backfill player without NBA id: ${displayName}`)

  const nameParts = displayName.trim().split(' ')
  const firstName = nameParts[0] ?? ''
  const lastName = nameParts.slice(1).join(' ') || firstName

  try {
    const newPlayer = await mustSupabase(
      'create backfill player',
      supabase
        .from('players')
        .insert({ first_name: firstName, last_name: lastName, ...(nbaId ? { nba_id: nbaId } : {}) })
        .select('id')
        .maybeSingle(),
    )
    if (!newPlayer?.id) throw new Error(`create backfill player returned no id for ${displayName}`)
    return newPlayer.id
  } catch (error) {
    const existingId = await findExistingPlayer(nbaId)
    if (existingId) return existingId
    throw error
  }
}

async function findExistingPlayer(nbaId: string): Promise<string | null> {
  if (nbaId) {
    const byNbaId = await mustSupabase(
      'reload player by NBA id',
      supabase
        .from('players')
        .select('id')
        .eq('nba_id', nbaId)
        .maybeSingle(),
    )
    if (byNbaId?.id) return byNbaId.id
  }

  return null
}

function setUniqueName(map: Map<string, string>, key: string, playerId: string): void {
  const existing = map.get(key)
  if (!existing) {
    map.set(key, playerId)
  } else if (existing !== playerId) {
    map.set(key, AMBIGUOUS)
  }
}

const SUFFIX_RE = /\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i

export function normalizeName(name: string): string {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/['\-]/g, '')
    .replace(SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export type PlayerLookupMaps = {
  byName: Map<string, string>
  byNormName: Map<string, string>
  byNbaId: Map<string, string>
  bySleeperId: Map<string, string>
  bySportsDataId: Map<string, string>
}

export function buildPlayerLookupMaps(
  players: {
    id: string
    display_name: string
    nba_id?: string | null
    sleeper_id?: string | null
    sportsdata_id?: string | null
  }[],
): PlayerLookupMaps {
  const byName = new Map<string, string>()
  const byNormName = new Map<string, string>()
  const byNbaId = new Map<string, string>()
  const bySleeperId = new Map<string, string>()
  const bySportsDataId = new Map<string, string>()

  for (const p of players) {
    byName.set(p.display_name.toLowerCase(), p.id)
    const norm = normalizeName(p.display_name)
    if (byNormName.has(norm)) {
      byNormName.set(norm, '__ambiguous__')
    } else {
      byNormName.set(norm, p.id)
    }
    if (p.nba_id) byNbaId.set(p.nba_id, p.id)
    if (p.sleeper_id) bySleeperId.set(p.sleeper_id, p.id)
    if (p.sportsdata_id) bySportsDataId.set(p.sportsdata_id, p.id)
  }

  return { byName, byNormName, byNbaId, bySleeperId, bySportsDataId }
}

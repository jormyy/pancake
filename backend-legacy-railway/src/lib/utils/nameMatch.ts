/**
 * Strips generational suffixes and periods so "O.G. Anunoby Jr."
 * and "OG Anunoby" both normalize to "og anunoby".
 */
const SUFFIX_RE = /\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i
export const AMBIGUOUS_PLAYER_ID = '__ambiguous__'

export function normalizeName(name: string): string {
    return name
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(SUFFIX_RE, '')
        .replace(/[.'\u2019\-]/g, '')
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

/**
 * Builds a set of lookup maps from a players query result.
 * Each map goes from some identifier → player.id.
 */
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
        setUniqueLookup(byName, p.display_name.toLowerCase(), p.id)
        setUniqueLookup(byNormName, normalizeName(p.display_name), p.id)

        if (p.nba_id) byNbaId.set(p.nba_id, p.id)
        if (p.sleeper_id) bySleeperId.set(p.sleeper_id, p.id)
        if (p.sportsdata_id) bySportsDataId.set(p.sportsdata_id, p.id)
    }

    return { byName, byNormName, byNbaId, bySleeperId, bySportsDataId }
}

export function lookupPlayerByName(maps: PlayerLookupMaps, displayName: string): string | null {
    const exact = maps.byName.get(displayName.toLowerCase())
    if (exact && exact !== AMBIGUOUS_PLAYER_ID) return exact

    const normalized = maps.byNormName.get(normalizeName(displayName))
    if (normalized && normalized !== AMBIGUOUS_PLAYER_ID) return normalized

    return null
}

function setUniqueLookup(map: Map<string, string>, key: string, playerId: string): void {
    const existing = map.get(key)
    if (!existing) {
        map.set(key, playerId)
    } else if (existing !== playerId) {
        map.set(key, AMBIGUOUS_PLAYER_ID)
    }
}

import { supabase } from '../lib/supabase'
import { scrapeDynastyRankings } from '../lib/scraper'

// ── Name normalization ────────────────────────────────────────
// Strips generational suffixes and periods so "O.G. Anunoby Jr."
// and "OG Anunoby" both normalize to "og anunoby".
const SUFFIX_RE = /\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i

function normalizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/\./g, '') // O.G. → OG
        .replace(SUFFIX_RE, '') // strip Jr. Sr. II III etc.
        .replace(/\s+/g, ' ')
        .trim()
}

export async function syncDynastyRankings() {
    console.log('[rankings] Scraping dynasty rankings...')
    const rankings = await scrapeDynastyRankings()
    console.log(`[rankings] Scraped ${rankings.length} players.`)

    const { data: players, error } = await supabase
        .from('players')
        .select('id, display_name, sportsdata_id')
    if (error) throw error

    // Build three lookup maps for the three matching tiers
    const bySpDataId = new Map<string, string>() // sportsdata_id    → player.id
    const byExactName = new Map<string, string>() // lower name       → player.id
    const byNormName = new Map<string, string>() // normalized name  → player.id

    for (const p of players ?? []) {
        bySpDataId.set(p.sportsdata_id, p.id)
        byExactName.set(p.display_name.toLowerCase(), p.id)
        // Only write normalized entry if it doesn't clash (ambiguous → skip)
        const norm = normalizeName(p.display_name)
        if (byNormName.has(norm)) {
            byNormName.set(norm, '__ambiguous__')
        } else {
            byNormName.set(norm, p.id)
        }
    }

    let matched = 0
    let matchedById = 0
    let matchedByExact = 0
    let matchedByNorm = 0
    const unmatched: string[] = []

    const updates: { id: string; dynasty_rank: number }[] = []

    for (const r of rankings) {
        let playerId: string | undefined

        // Tier 1: match by SportsData.io ID (most reliable)
        if (r.siteId) {
            playerId = bySpDataId.get(r.siteId)
            if (playerId) matchedById++
        }

        // Tier 2: exact case-insensitive name match
        if (!playerId) {
            playerId = byExactName.get(r.name.toLowerCase())
            if (playerId) matchedByExact++
        }

        // Tier 3: normalized name (strips suffixes + periods)
        if (!playerId) {
            const norm = normalizeName(r.name)
            const candidate = byNormName.get(norm)
            if (candidate && candidate !== '__ambiguous__') {
                playerId = candidate
                matchedByNorm++
            }
        }

        if (playerId) {
            updates.push({ id: playerId, dynasty_rank: r.rank })
            matched++
        } else {
            unmatched.push(`#${r.rank} "${r.name}" (${r.team})`)
        }
    }

    // Batch update in chunks of 500
    const CHUNK = 500
    for (let i = 0; i < updates.length; i += CHUNK) {
        const chunk = updates.slice(i, i + CHUNK)
        const { error: upErr } = await supabase.from('players').upsert(chunk, { onConflict: 'id' })
        if (upErr) throw upErr
    }

    // Clear dynasty_rank for players no longer on the list
    const rankedIds = new Set(updates.map((u) => u.id))
    const { data: currentlyRanked } = await supabase
        .from('players')
        .select('id')
        .not('dynasty_rank', 'is', null)

    const toClear = (currentlyRanked ?? []).filter((p) => !rankedIds.has(p.id)).map((p) => p.id)

    if (toClear.length > 0) {
        await supabase.from('players').update({ dynasty_rank: null }).in('id', toClear)
    }

    console.log(
        `[rankings] Matched ${matched}/${rankings.length} ` +
            `(ID: ${matchedById}, exact: ${matchedByExact}, normalized: ${matchedByNorm}). ` +
            `Unmatched: ${unmatched.length}.`,
    )

    if (unmatched.length > 0) {
        console.log('[rankings] Unmatched — add manual overrides if needed:')
        unmatched.forEach((u) => console.log(' ', u))
    }
}

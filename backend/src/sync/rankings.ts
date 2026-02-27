import { supabase } from '../lib/supabase'
import { scrapeDynastyRankings } from '../lib/scraper'

export async function syncDynastyRankings() {
  console.log('[rankings] Scraping dynasty rankings...')
  const rankings = await scrapeDynastyRankings()
  console.log(`[rankings] Scraped ${rankings.length} players.`)

  // Fetch all players from DB (just id + display_name)
  const { data: players, error } = await supabase
    .from('players')
    .select('id, display_name')

  if (error) throw error

  // Build lookup map: lowercase name → player id
  const nameMap = new Map<string, string>()
  for (const p of players ?? []) {
    nameMap.set(p.display_name.toLowerCase(), p.id)
  }

  let matched = 0
  let unmatched = 0
  const unmatched_names: string[] = []

  // Build upsert rows for matched players
  const updates: { id: string; dynasty_rank: number }[] = []

  for (const r of rankings) {
    const playerId = nameMap.get(r.name.toLowerCase())
    if (playerId) {
      updates.push({ id: playerId, dynasty_rank: r.rank })
      matched++
    } else {
      unmatched_names.push(`#${r.rank} ${r.name}`)
      unmatched++
    }
  }

  // Batch update in chunks of 500 to avoid request size limits
  const CHUNK = 500
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK)
    const { error: upErr } = await supabase
      .from('players')
      .upsert(chunk, { onConflict: 'id' })
    if (upErr) throw upErr
  }

  // Clear dynasty_rank for players no longer in the rankings
  const rankedIds = new Set(updates.map((u) => u.id))
  const { data: currentlyRanked } = await supabase
    .from('players')
    .select('id')
    .not('dynasty_rank', 'is', null)

  const toClear = (currentlyRanked ?? [])
    .filter((p) => !rankedIds.has(p.id))
    .map((p) => p.id)

  if (toClear.length > 0) {
    await supabase
      .from('players')
      .update({ dynasty_rank: null })
      .in('id', toClear)
  }

  console.log(`[rankings] Updated ${matched} players. Unmatched: ${unmatched}.`)
  if (unmatched_names.length > 0) {
    console.log('[rankings] Unmatched players:', unmatched_names.slice(0, 20).join(', '))
  }
}

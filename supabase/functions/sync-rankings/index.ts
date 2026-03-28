import { supabase } from '../_shared/supabase.ts'
import { normalizeName } from '../_shared/nameMatch.ts'
import * as cheerio from 'npm:cheerio'

const RANKINGS_URL = 'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings'
const CHUNK = 500

Deno.serve(async () => {
  try {
    await syncDynastyRankings()
    return Response.json({ ok: true })
  } catch (e: any) {
    console.error('[sync-rankings]', e)
    return Response.json({ ok: false, error: e.message }, { status: 500 })
  }
})

async function syncDynastyRankings() {
  console.log('[sync-rankings] Scraping dynasty rankings...')
  const rankings = await scrapeDynastyRankings()
  console.log(`[sync-rankings] Scraped ${rankings.length} players.`)

  const { data: players, error } = await supabase
    .from('players')
    .select('id, display_name, sportsdata_id')
  if (error) throw error

  const bySpDataId = new Map<string, string>()
  const byExactName = new Map<string, string>()
  const byNormName = new Map<string, string>()

  for (const p of players ?? []) {
    if (p.sportsdata_id) bySpDataId.set(p.sportsdata_id, p.id)
    byExactName.set(p.display_name.toLowerCase(), p.id)
    const norm = normalizeName(p.display_name)
    if (byNormName.has(norm)) {
      byNormName.set(norm, '__ambiguous__')
    } else {
      byNormName.set(norm, p.id)
    }
  }

  let matched = 0
  const updates: { id: string; dynasty_rank: number }[] = []

  for (const r of rankings) {
    let playerId: string | undefined

    if (r.siteId) {
      playerId = bySpDataId.get(r.siteId)
    }
    if (!playerId) {
      playerId = byExactName.get(r.name.toLowerCase())
    }
    if (!playerId) {
      const norm = normalizeName(r.name)
      const candidate = byNormName.get(norm)
      if (candidate && candidate !== '__ambiguous__') playerId = candidate
    }

    if (playerId) {
      updates.push({ id: playerId, dynasty_rank: r.rank })
      matched++
    }
  }

  for (let i = 0; i < updates.length; i += CHUNK) {
    const { error: upErr } = await supabase
      .from('players')
      .upsert(updates.slice(i, i + CHUNK), { onConflict: 'id' })
    if (upErr) throw upErr
  }

  // Clear dynasty_rank for players no longer on the list
  const rankedIds = new Set(updates.map((u) => u.id))
  const { data: currentlyRanked } = await supabase
    .from('players')
    .select('id')
    .not('dynasty_rank', 'is', null)

  const toClear = (currentlyRanked ?? []).filter((p: any) => !rankedIds.has(p.id)).map((p: any) => p.id)
  if (toClear.length > 0) {
    await supabase.from('players').update({ dynasty_rank: null }).in('id', toClear)
  }

  console.log(`[sync-rankings] Matched ${matched}/${rankings.length} players.`)
}

async function scrapeDynastyRankings() {
  const res = await fetch(RANKINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PancakeApp/1.0)' },
  })
  if (!res.ok) throw new Error(`Rankings fetch ${res.status}`)
  const html = await res.text()
  const $ = cheerio.load(html)

  const rankings: Array<{ rank: number; name: string; team: string; siteId: string | null }> = []

  $('table.table--statistics tr').each((_: number, row: unknown) => {
    const cells = $(row).find('td.dynasty.d-none')
    if (cells.length < 5) return

    const rankText = $(cells[0]).find('span').first().text().replace('#', '').trim()
    const rank = parseInt(rankText)
    if (isNaN(rank)) return

    const name = $(cells[1])
      .contents()
      .filter((_: number, n: any) => n.type === 'text')
      .first()
      .text()
      .trim()
    const siteId = $(cells[1]).find('input[type="hidden"]').attr('value') ?? null
    const team = $(cells[3]).text().trim()

    if (name) rankings.push({ rank, name, team, siteId })
  })

  return rankings
}

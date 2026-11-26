import type { supabase } from '../_shared/supabase.ts'
import { errorMessage } from '../_shared/responses.ts'
import { runBounded } from '../_shared/runBounded.ts'
import { workFetch } from '../_shared/workContext.ts'

type Client = Pick<typeof supabase, 'rpc'>
type Source = 'espn' | 'nba_index' | 'nba_profile'

export type ListedSize = { provider_id: string; height_inches?: number; weight_lb?: number }
export type IndexDraft = { provider_id: string; draft_year: number; draft_round: number; draft_overall_pick: number }
export type ListedDetailTotals = { matched: number; updated: number; conflicts: number; missing: string[] }

const CHUNK = 500

export function espnSizeRecords(records: { espn_id: string; height_inches: number | null; weight_lb: number | null }[]): ListedSize[] {
  return records.flatMap(record => record.height_inches == null && record.weight_lb == null ? [] : [{
    provider_id: record.espn_id,
    ...(record.height_inches == null ? {} : { height_inches: record.height_inches }),
    ...(record.weight_lb == null ? {} : { weight_lb: record.weight_lb }),
  }])
}

const integer = (value: unknown) => typeof value === 'number' && Number.isInteger(value) ? value
  : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null

export function indexDraftRecords(headers: string[], rows: unknown[][]): { drafted: IndexDraft[]; unlisted: string[] } {
  const [person, year, round, pick] = ['PERSON_ID', 'DRAFT_YEAR', 'DRAFT_ROUND', 'DRAFT_NUMBER'].map(name => headers.indexOf(name))
  if ([person, year, round, pick].some(index => index < 0)) return { drafted: [], unlisted: [] }
  const drafted: IndexDraft[] = []
  const unlisted: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = String(row[person] ?? '')
    if (!/^\d+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    const values = [row[year], row[round], row[pick]]
    if (values.every(value => value == null || value === '')) { unlisted.push(id); continue }
    const [draftYear, draftRound, draftPick] = values.map(integer)
    if (draftYear != null && draftYear >= 1947 && draftYear <= 2100 && draftRound != null && draftRound >= 1 && draftRound <= 10
      && draftPick != null && draftPick >= 1 && draftPick <= 300) {
      drafted.push({ provider_id: id, draft_year: draftYear, draft_round: draftRound, draft_overall_pick: draftPick })
    }
  }
  return { drafted, unlisted }
}

export async function applyListedDetails(db: Client, source: Source, records: (ListedSize | IndexDraft | { provider_id: string; draft_status: 'undrafted' })[]): Promise<ListedDetailTotals> {
  const totals: ListedDetailTotals = { matched: 0, updated: 0, conflicts: 0, missing: [] }
  for (let offset = 0; offset < records.length; offset += CHUNK) {
    const { data, error } = await db.rpc('apply_player_listed_details', { p_source: source, p_records: records.slice(offset, offset + CHUNK) })
    if (error) throw new Error(`Listed ${source} details: ${errorMessage(error)}`)
    const receipt = data as { matched?: unknown; updated?: unknown; conflicts?: unknown; missing?: unknown } | null
    if (!receipt || typeof receipt.matched !== 'number' || typeof receipt.updated !== 'number'
      || typeof receipt.conflicts !== 'number' || !Array.isArray(receipt.missing)) {
      throw new Error(`Invalid listed ${source} details receipt`)
    }
    totals.matched += receipt.matched
    totals.updated += receipt.updated
    totals.conflicts += receipt.conflicts
    totals.missing.push(...receipt.missing.map(String))
  }
  return totals
}

export function profileDraftStatus(info: unknown): 'undrafted' | 'drafted' | null {
  if (!info || typeof info !== 'object') return null
  const fields = ['DRAFT_YEAR', 'DRAFT_ROUND', 'DRAFT_NUMBER'].map(name => (info as Record<string, unknown>)[name])
  if (fields.every(value => typeof value === 'string' && value.trim().toLowerCase() === 'undrafted')) return 'undrafted'
  return fields.every(value => integer(value) != null) ? 'drafted' : null
}

type ProfilePlayer = { nba_id: string; display_name: string | null }

async function fetchProfileDraftStatus(player: ProfilePlayer, fetcher: typeof workFetch) {
  const base = Deno.env.get('NBA_COM_BASE_URL') ?? 'https://www.nba.com'
  const slug = (player.display_name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const response = await fetcher(`${base}/player/${encodeURIComponent(player.nba_id)}${slug ? `/${slug}` : ''}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nba.com/' }, signal: AbortSignal.timeout(4000),
  })
  if (response.status === 404) { await response.body?.cancel(); return null }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`NBA profile ${response.status}`) }
  const html = await response.text()
  const embedded = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  const info = embedded ? JSON.parse(embedded[1])?.props?.pageProps?.player?.info : null
  if (info && String(info.PERSON_ID) !== player.nba_id) throw new Error('NBA draft profile identity mismatch')
  return profileDraftStatus(info)
}

export async function verifyUndraftedProfiles(db: Client, players: ProfilePlayer[], budgetMs: number,
  options: { intervalMs?: number; fetcher?: typeof workFetch } = {}) {
  const intervalMs = options.intervalMs ?? 500
  const fetcher = options.fetcher ?? workFetch
  const deadline = performance.now() + Math.max(0, budgetMs)
  const verified: { provider_id: string; draft_status: 'undrafted' }[] = []
  const failures: string[] = []
  let deferred = 0
  let limited = false
  let next = performance.now()
  await runBounded(players.map(player => async () => {
    const scheduled = Math.max(performance.now(), next)
    if (limited || scheduled >= deadline) { deferred++; return }
    next = scheduled + intervalMs
    const wait = Math.max(0, scheduled - performance.now())
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
    if (limited) { deferred++; return }
    try {
      if (await fetchProfileDraftStatus(player, fetcher) === 'undrafted') verified.push({ provider_id: player.nba_id, draft_status: 'undrafted' })
    } catch (error) {
      const message = errorMessage(error)
      if (/NBA profile (403|429)/.test(message)) limited = true
      failures.push(`Draft profile ${player.nba_id}: ${message}`)
    }
  }), 2)
  const applied = verified.length ? await applyListedDetails(db, 'nba_profile', verified) : { matched: 0, updated: 0, conflicts: 0, missing: [] }
  if (deferred) console.log(`[sync-players] Draft profiles: ${deferred} remaining after ${limited ? 'the source limited requests' : 'the time budget'}`)
  return { checked: players.length - deferred, deferred, verified: verified.length, updated: applied.updated, conflicts: applied.conflicts, failures }
}

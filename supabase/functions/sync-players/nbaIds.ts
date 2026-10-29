import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { AMBIGUOUS, normalizeName, setUnique } from '../_shared/nameMatch.ts'
import { resolvePlayerImports } from '../_shared/playerImports.ts'
import { linkPlayerSources, type SourceLinkRecord } from '../_shared/sourceLinks.ts'
import { fetchAllPlayers } from './players.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { planNbaLinks, type NbaLinkPlayer } from './nbaLinkPlan.ts'
import { corroborateRoster } from './rosterIdentity.ts'

const NBA_CDN_BASE_URL = Deno.env.get('NBA_CDN_BASE_URL') ?? 'https://cdn.nba.com/static/json'
const NBA_PLAYER_INDEX_URL = `${NBA_CDN_BASE_URL}/staticData/playerIndex.json`
const CHUNK = 50

type NbaIndex = { resultSets?: { headers: string[]; rowSet: unknown[][] }[] }

async function fetchNbaIndex(): Promise<NbaIndex> {
  const res = await fetchWithRetry(NBA_PLAYER_INDEX_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://www.nba.com/',
      'Origin': 'https://www.nba.com',
    },
  })
  if (!res.ok) throw new Error(`NBA player index ${res.status}`)

  return await res.json() as NbaIndex
}

function readRoster(data: NbaIndex, now: Date) {
  const rs = data?.resultSets?.[0]
  if (!rs) throw new Error('Unexpected NBA player index shape')

  const headers = rs.headers
  const rows = rs.rowSet

  const pidIdx = headers.indexOf('PERSON_ID')
  const firstIdx = headers.indexOf('PLAYER_FIRST_NAME')
  const lastIdx = headers.indexOf('PLAYER_LAST_NAME')
  const statusIdx = headers.indexOf('ROSTER_STATUS')
  if ([pidIdx, firstIdx, lastIdx, statusIdx].some(index => index < 0)) throw new Error('Unexpected NBA player index columns')

  const teamIndex = headers.indexOf('TEAM_ABBREVIATION')
  const positionIndex = headers.indexOf('POSITION')
  const fromIndex = headers.indexOf('FROM_YEAR')
  const draftIndex = headers.indexOf('DRAFT_YEAR')
  const currentSeason = currentSeasonYear(now)
  const validTeams = new Set(['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS'])
  const rosterRecords: SourceLinkRecord[] = rows.filter(row => row[statusIdx] === 1 && validTeams.has(String(row[teamIndex]))).map(row => {
    const firstYear = Number(row[fromIndex] || row[draftIndex])
    const rawPosition = String(row[positionIndex] ?? '').toUpperCase()
    const position = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'].includes(rawPosition) ? rawPosition
      : rawPosition.startsWith('G') ? 'G' : rawPosition.startsWith('F') ? 'F' : rawPosition.startsWith('C') ? 'C' : null
    return { provider_id: String(row[pidIdx]), display_name: `${row[firstIdx]} ${row[lastIdx]}`,
      nba_team: String(row[teamIndex]), position,
      years_exp: Number.isInteger(firstYear) && firstYear > 1946 && firstYear <= currentSeason ? Math.max(0, currentSeason - 1 - firstYear) : null }
  })
  return { headers, rows, pidIdx, firstIdx, lastIdx, statusIdx, teamIndex, rosterRecords, validTeams }
}

export async function prepareEspnIdentities(records: Parameters<typeof corroborateRoster>[1], now = new Date()) {
  const data = await fetchNbaIndex()
  const { rosterRecords } = readRoster(data, now)
  const players = await fetchAllPlayers<NbaLinkPlayer>(supabase,
    'id, display_name, nba_id, nba_team, espn_id, sleeper_id, years_exp, position, eligible_positions')
  const bridges = planNbaLinks(corroborateRoster(rosterRecords, records), players, false).pending.map(row => row.record)
  let linked = 0
  for (let offset = 0; offset < bridges.length; offset += CHUNK) {
    const results = await linkPlayerSources(supabase, 'nba', bridges.slice(offset, offset + CHUNK))
    linked += results.filter(row => row.action === 'updated').length
  }
  return { data, linked }
}

// Fetch the NBA CDN player index and populate nba_id for any players missing it.
// The index includes all active NBA players with their PERSON_ID, first name, and last name
// (last name includes suffix, e.g. "Jackson Jr.", "Payton II").
export async function syncNBAIds(now = new Date(), prepared?: NbaIndex): Promise<{ mapped: number; merged: number; failures: string[]; roster: { provider_id: string; nba_team: string }[]; rosterGaps: string[] }> {
  console.log('[sync-players] Syncing NBA person IDs from CDN index...')

  const data = prepared ?? await fetchNbaIndex()
  const { headers, rows, pidIdx, firstIdx, lastIdx, statusIdx, teamIndex, rosterRecords, validTeams } = readRoster(data, now)
  const rosterGaps: string[] = []
  if (rosterRecords.length < 350) rosterGaps.push('NBA roster has fewer than 350 active players')
  if (new Set(rosterRecords.map(row => row.nba_team)).size !== 30) rosterGaps.push('NBA roster does not cover all 30 teams')
  if (rows.some(row => row[statusIdx] === 1 && !validTeams.has(String(row[teamIndex])))) rosterGaps.push('NBA roster contains an unknown active team')
  const currentRoster = rosterGaps.length === 0
  const stored = await fetchAllPlayers<NbaLinkPlayer>(supabase,
    'id, display_name, nba_id, nba_team, espn_id, sleeper_id, years_exp, position, eligible_positions')
  const plan = planNbaLinks(rosterRecords, stored, currentRoster)
  const links: { index: number; player_id: string | null; action: string }[] = [...plan.completed]
  for (let offset = 0; offset < plan.pending.length; offset += 50) {
    const batch = plan.pending.slice(offset, offset + 50)
    const results = await linkPlayerSources(supabase, 'nba', batch.map(row => row.record), currentRoster)
    links.push(...results.map(row => ({ ...row, index: batch[row.index].index })))
  }
  links.sort((a, b) => a.index - b.index)
  const linkFailures = links.filter(row => row.action === 'ambiguous').map(row => `NBA roster provider ${rosterRecords[row.index].provider_id}: ambiguous`)

  // Build maps from the active CDN index. Exact names are preferred; normalized
  // names are used only when unique on both the CDN and DB sides.
  const byExactName = new Map<string, string>()
  const byNormName = new Map<string, string>()
  for (const row of rows) {
    if (row[statusIdx] !== 1) continue // skip inactive
    const fullName = `${row[firstIdx]} ${row[lastIdx]}`
    const exact = fullName.toLowerCase()
    const norm = normalizeName(fullName)
    const personId = String(row[pidIdx])
    setUnique(byExactName, exact, personId)
    setUnique(byNormName, norm, personId)
  }

  const players = await fetchAllPlayers<{ id: string; display_name: string | null; nba_id: string | null }>(
    supabase,
    'id, display_name, nba_id',
  )

  const dbNormCounts = new Map<string, number>()
  const dbExactCounts = new Map<string, number>()
  for (const player of players) {
    if (!player.display_name) continue
    const exact = player.display_name.toLowerCase()
    const norm = normalizeName(player.display_name)
    dbExactCounts.set(exact, (dbExactCounts.get(exact) ?? 0) + 1)
    dbNormCounts.set(norm, (dbNormCounts.get(norm) ?? 0) + 1)
  }

  const updates: { id: string; nba_id: string; expected_display_name: string; name_match: string }[] = []
  for (const p of players) {
    if (!p.display_name) continue
    const exact = p.display_name.toLowerCase()
    const norm = normalizeName(p.display_name)
    const exactPersonId = byExactName.get(exact)
    const normPersonId = byNormName.get(norm)
    const personId = exactPersonId && exactPersonId !== AMBIGUOUS && dbExactCounts.get(exact) === 1
      ? exactPersonId
      : (dbNormCounts.get(norm) === 1 && normPersonId && normPersonId !== AMBIGUOUS ? normPersonId : null)
    if (personId && !p.nba_id && !rosterRecords.some(record => record.provider_id === personId)) {
      updates.push({ id: p.id, nba_id: personId, expected_display_name: p.display_name,
        name_match: exactPersonId === personId && dbExactCounts.get(exact) === 1 ? 'exact' : 'normalized' })
    }
  }

  const failures: string[] = [...linkFailures]
  let mergedBeforeUpdate = 0
  let mapped = links.filter(row => row.action === 'updated' || row.action === 'inserted').length
  for (let offset = 0; offset < updates.length; offset += CHUNK) {
    const chunk = updates.slice(offset, offset + CHUNK)
    const { results } = await resolvePlayerImports('nba_index', chunk.map((update) => ({
      player_id: update.id, provider_id: update.nba_id,
      expected_display_name: update.expected_display_name, name_match: update.name_match,
    })))
    for (const row of results) {
      if (!row.player_id) {
        failures.push(`NBA index provider ${chunk[row.index].nba_id}: ${row.action}`)
        continue
      }
      if (row.player_id !== chunk[row.index].id) mergedBeforeUpdate++
      else mapped++
    }
  }
  console.log(`[sync-players] Updated nba_id for ${mapped} players; merged ${mergedBeforeUpdate} duplicate rows before update.`)

  // Merge any players that ended up with the same nba_id (same real person, two DB rows)
  const { error: mergeErr } = await supabase.rpc('merge_duplicate_players')
  if (mergeErr) failures.push(`merge_duplicate_players: ${mergeErr.message}`)
  else console.log('[sync-players] Dedup complete.')

  const firstYearIndex = headers.indexOf('FROM_YEAR')
  const draftYearIndex = headers.indexOf('DRAFT_YEAR')
  const experience = new Map<string, number>()
  const seasonYear = currentSeasonYear(now)
  for (const row of rows) {
    const firstYear = Number(row[firstYearIndex] || row[draftYearIndex])
    if (Number.isInteger(firstYear) && firstYear > 1946 && firstYear <= seasonYear) {
      experience.set(String(row[pidIdx]), Math.max(0, seasonYear - 1 - firstYear))
    }
  }
  if (experience.size > 0) {
    const current = await fetchAllPlayers<{ id: string; nba_id: string | null; years_exp: number | null }>(supabase, 'id, nba_id, years_exp')
    for (const player of current) {
      if (!player.nba_id || player.years_exp != null || !experience.has(player.nba_id)) continue
      const { error } = await supabase.from('players').update({ years_exp: experience.get(player.nba_id)! })
        .eq('id', player.id).eq('nba_id', player.nba_id).is('years_exp', null)
      if (error) failures.push(`NBA experience ${player.id}: ${error.message}`)
    }
  }

  return { mapped, merged: mergedBeforeUpdate, failures, roster: rosterRecords.map(({ provider_id, nba_team }) => ({ provider_id, nba_team })), rosterGaps }
}

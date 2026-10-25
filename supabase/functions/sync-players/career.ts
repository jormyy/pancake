import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { workFetch } from '../_shared/workContext.ts'
import { runBounded } from '../_shared/runBounded.ts'
import { careerFirstSeasonYear, careerGamesBase } from '../_shared/careerGames.ts'
import { normalizeName } from '../_shared/nameMatch.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { errorMessage } from '../_shared/responses.ts'
import { fetchAllPlayers } from './players.ts'
import { fetchNbaCareerProfile } from './nbaCareer.ts'

const ESPN_CAREER_BASE_URL = Deno.env.get('ESPN_CAREER_BASE_URL') ??
  'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba'
const ESPN_SEARCH_BASE_URL = Deno.env.get('ESPN_SEARCH_BASE_URL') ??
  'https://site.web.api.espn.com/apis/common/v3/search'

type CareerPlayer = {
  id: string; display_name: string; espn_id: string | null; nba_id: string | null; nba_team: string | null
  years_exp: number | null; career_regular_season_games: number | null; career_games_base: number | null; career_games_base_source: string | null; career_games_base_attempted_at: string | null
}

async function linkEspnId(player: CareerPlayer, players: CareerPlayer[], signal: AbortSignal): Promise<string> {
  const name = normalizeName(player.display_name)
  if (players.filter(row => normalizeName(row.display_name) === name).length !== 1) {
    throw new Error('ESPN lookup has an ambiguous stored name')
  }
  const url = new URL(ESPN_SEARCH_BASE_URL)
  url.searchParams.set('query', player.display_name)
  url.searchParams.set('type', 'player')
  url.searchParams.set('limit', '50')
  const response = await fetchWithRetry(url, { signal }, { attemptTimeoutMs: 4000 })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`ESPN lookup ${response.status}`)
  }
  const payload = await response.json() as { items?: { id?: string; displayName?: string; league?: string; type?: string }[] }
  const matches = Array.isArray(payload.items) ? payload.items.filter(row => row?.type === 'player' && row.league === 'nba'
    && typeof row.id === 'string' && /^\d+$/.test(row.id) && typeof row.displayName === 'string' && normalizeName(row.displayName) === name) : []
  const ids = [...new Set(matches.map(row => row.id!))]
  if (ids.length !== 1) throw new Error(`ESPN lookup found ${ids.length} matching NBA identities`)
  const espnId = ids[0]
  if (players.some(row => row.id !== player.id && row.espn_id === espnId)) throw new Error('ESPN lookup identity already belongs to another player')
  let query = supabase.from('players').update({ espn_id: espnId }).eq('id', player.id)
    .eq('display_name', player.display_name).is('espn_id', null).abortSignal(signal)
  if (player.nba_id) query = query.eq('nba_id', player.nba_id)
  const { data, error } = await query.select('id, espn_id')
  if (error) throw error
  if (data?.length !== 1 || data[0].espn_id !== espnId) throw new Error('ESPN lookup identity changed before linking')
  player.espn_id = espnId
  return espnId
}

async function fetchEspnExperience(espnId: string, now: Date, signal: AbortSignal): Promise<number | null> {
  const response = await fetchWithRetry(`${ESPN_CAREER_BASE_URL}/athletes/${espnId}`, { signal }, { attemptTimeoutMs: 4000 })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`ESPN athlete biography ${response.status}`)
  }
  const payload = await response.json() as {
    league?: { slug?: string }
    athlete?: { id?: string; displayExperience?: string; displayDraft?: string }
  }
  if (payload?.league?.slug !== 'nba' || payload.athlete?.id !== espnId) throw new Error('ESPN athlete biography identity mismatch')
  const experience = payload.athlete.displayExperience
  if (experience === 'Rookie') return 0
  const season = experience?.match(/^(\d+)(?:st|nd|rd|th) Season$/)
  if (season && Number(season[1]) > 0) return Number(season[1]) - 1
  const draft = payload.athlete.displayDraft?.match(/^(\d{4}):/)
  const year = draft ? Number(draft[1]) : null
  return year !== null && year > 1946 && year <= currentSeasonYear(now) ? Math.max(0, currentSeasonYear(now) - 1 - year) : null
}

type CareerSyncOptions = { maxPlayers?: number; budgetMs?: number; lookupTimeoutMs?: number }

export async function syncCareerGames(now = new Date(), options: CareerSyncOptions = {}): Promise<{ updated: number; unverified: number; failures: string[] }> {
  const maxPlayers = Math.min(300, Math.max(0, options.maxPlayers ?? 300))
  const budgetMs = Math.min(90000, Math.max(0, options.budgetMs ?? 90000))
  const timeoutMs = Math.min(8000, Math.max(1, options.lookupTimeoutMs ?? 8000))
  const started = performance.now()
  const players = await fetchAllPlayers<CareerPlayer>(supabase,
    'id, display_name, espn_id, nba_id, nba_team, years_exp, career_regular_season_games, career_games_base, career_games_base_source, career_games_base_attempted_at')
  const missing = players.filter(player => (player.career_regular_season_games == null || player.career_regular_season_games < 65)
    && (player.career_games_base == null || player.career_games_base_source === 'coverage'))
  if (missing.length === 0) return { updated: 0, unverified: 0, failures: [] }
  const targets = missing.filter(player => !player.career_games_base_attempted_at
    || now.getTime() - Date.parse(player.career_games_base_attempted_at) >= 7 * 86400000)
    .sort((a, b) => Number(Boolean(b.nba_team)) - Number(Boolean(a.nba_team))
      || (a.career_regular_season_games == null ? Infinity : Math.abs(a.career_regular_season_games - 65))
        - (b.career_regular_season_games == null ? Infinity : Math.abs(b.career_regular_season_games - 65))
      || (a.career_games_base_attempted_at ?? '').localeCompare(b.career_games_base_attempted_at ?? '') || a.id.localeCompare(b.id))
    .slice(0, maxPlayers)
  let updated = 0
  let unverified = missing.length
  const failures: string[] = []
  await runBounded(targets.map(player => async () => {
    if (performance.now() - started >= budgetMs) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Career base lookup deadline exceeded')), timeoutMs)
    const signal = controller.signal
    try {
      const claim = await supabase.rpc('claim_player_career_base_atomic', { p_player_id: player.id, p_now: now.toISOString() }).abortSignal(AbortSignal.timeout(4000))
      if (claim.error) { failures.push(`${player.id}: ${claim.error.message}`); return }
      if (!claim.data) return
      const problems: string[] = []
      let espnId = player.espn_id
      if (!espnId) {
        try { espnId = await linkEspnId(player, players, signal) }
        catch (error) { problems.push(errorMessage(error)) }
      }
      let payload: unknown = null
      if (espnId) {
        try {
          const response = await workFetch(`${ESPN_CAREER_BASE_URL}/athletes/${espnId}/stats?seasontype=2`, { signal })
          if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`ESPN career stats ${response.status}`)
          }
          payload = await response.json()
        } catch (error) { problems.push(errorMessage(error)) }
      }
      const season = currentSeasonYear(now)
      const base = careerGamesBase(payload, season - 1)
      let years = player.years_exp
      const firstSeason = careerFirstSeasonYear(payload)
      if (years == null && firstSeason !== null && firstSeason <= season) years = season - firstSeason
      if (base == null && years == null && espnId) {
        try { years = await fetchEspnExperience(espnId, now, signal) }
        catch (error) { problems.push(errorMessage(error)) }
      }
      if (base == null && player.nba_id && years == null) {
        try { years = (await fetchNbaCareerProfile(player.nba_id, now, signal)).years }
        catch (error) { problems.push(errorMessage(error)) }
      }
      if (player.years_exp == null && years != null) {
        let query = supabase.from('players').update({ years_exp: years }).eq('id', player.id).is('years_exp', null).abortSignal(AbortSignal.timeout(4000))
        query = espnId ? query.eq('espn_id', espnId) : query.is('espn_id', null)
        if (player.nba_id) query = query.eq('nba_id', player.nba_id)
        const { data, error } = await query.select('id')
        if (error) failures.push(`${player.id}: ${error.message}`)
        else if (data?.length !== 1) failures.push(`${player.id}: Player identity changed before experience update`)
      }
      const saved = await supabase.rpc('complete_player_career_base_atomic', {
        p_player_id: player.id, p_espn_id: espnId ?? '', p_nba_id: player.nba_id ?? '', p_season_year: season,
        ...(base == null ? {} : { p_base: base, p_base_season: season - 1 }),
      }).abortSignal(AbortSignal.timeout(4000))
      if (saved.error) failures.push(`${player.id}: ${saved.error.message}`)
      else if (saved.data) { updated++; unverified-- }
      else if (base != null) failures.push(`${player.id}: Player identity changed or career base would lower the stored count`)
      else console.warn(`[sync-players] career ${player.id}: ${[...problems, 'NBA career base is unverified'].join('; ')}`)
    } catch (error) {
      console.warn(`[sync-players] career ${player.id}: ${errorMessage(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }), 16)
  return { updated, unverified, failures }
}

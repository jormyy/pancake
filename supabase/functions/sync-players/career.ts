import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { runBounded } from '../_shared/runBounded.ts'
import { careerFirstSeasonYear, careerGamesPrior } from '../_shared/careerGames.ts'
import { normalizeName } from '../_shared/nameMatch.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { errorMessage } from '../_shared/responses.ts'
import { fetchAllPlayers, PLAYER_PAGE } from './players.ts'
import { fetchNbaCareerProfile } from './nbaCareer.ts'

const ESPN_CAREER_BASE_URL = Deno.env.get('ESPN_CAREER_BASE_URL') ??
  'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba'
const ESPN_SEARCH_BASE_URL = Deno.env.get('ESPN_SEARCH_BASE_URL') ??
  'https://site.web.api.espn.com/apis/common/v3/search'

type CareerPlayer = {
  id: string; display_name: string; espn_id: string | null; nba_id: string | null; nba_team: string | null
  years_exp: number | null; career_regular_season_games: number | null; career_games_prior: number | null; career_games_prior_checked_at: string | null
}

async function rosteredPlayerIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  let after: string | null = null
  while (true) {
    let query = supabase.from('roster_players').select('id, player_id, league_seasons!inner(is_current)')
      .eq('league_seasons.is_current', true).order('id').limit(PLAYER_PAGE)
    if (after) query = query.gt('id', after)
    const { data, error } = await query
    if (error) throw error
    for (const row of data ?? []) ids.add(row.player_id)
    if (!data || data.length < PLAYER_PAGE) return ids
    after = data[data.length - 1].id
  }
}

async function linkEspnId(player: CareerPlayer, players: CareerPlayer[]): Promise<string> {
  const name = normalizeName(player.display_name)
  if (players.filter(row => normalizeName(row.display_name) === name).length !== 1) {
    throw new Error('ESPN lookup has an ambiguous stored name')
  }
  const url = new URL(ESPN_SEARCH_BASE_URL)
  url.searchParams.set('query', player.display_name)
  url.searchParams.set('type', 'player')
  url.searchParams.set('limit', '50')
  const response = await fetchWithRetry(url, undefined, { attemptTimeoutMs: 5000 })
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
    .eq('display_name', player.display_name).is('espn_id', null)
  if (player.nba_id) query = query.eq('nba_id', player.nba_id)
  const { data, error } = await query.select('id, espn_id')
  if (error) throw error
  if (data?.length !== 1 || data[0].espn_id !== espnId) throw new Error('ESPN lookup identity changed before linking')
  player.espn_id = espnId
  return espnId
}

async function fetchEspnExperience(espnId: string, now: Date): Promise<number | null> {
  const response = await fetchWithRetry(`${ESPN_CAREER_BASE_URL}/athletes/${espnId}`, undefined, { attemptTimeoutMs: 5000 })
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

export async function syncCareerGames(now = new Date()): Promise<{ updated: number; unverified: number; failures: string[] }> {
  const players = await fetchAllPlayers<CareerPlayer>(supabase,
    'id, display_name, espn_id, nba_id, nba_team, years_exp, career_regular_season_games, career_games_prior, career_games_prior_checked_at')
  if (players.length === 0) return { updated: 0, unverified: 0, failures: [] }
  const rostered = await rosteredPlayerIds()
  const targets = players.filter(player => {
    const needsPrior = player.career_games_prior == null && (player.career_regular_season_games ?? 0) < 65
    const due = !player.career_games_prior_checked_at || now.getTime() - Date.parse(player.career_games_prior_checked_at) >= 7 * 86400000
    return (player.nba_team || rostered.has(player.id)) && (needsPrior || player.years_exp == null) && due
  })
  let updated = 0
  let unverified = 0
  const failures: string[] = []
  await runBounded(targets.map(player => async () => {
    const claim = await supabase.rpc('claim_player_career_prior_atomic', { p_player_id: player.id, p_now: now.toISOString() })
    if (claim.error) { failures.push(`${player.id}: ${claim.error.message}`); return }
    if (!claim.data) return
    const problems: string[] = []
    let espnId = player.espn_id
    if (!espnId) {
      try { espnId = await linkEspnId(player, players) }
      catch (error) { problems.push(errorMessage(error)) }
    }
    let payload: unknown = null
    const needsPrior = player.career_games_prior == null && (player.career_regular_season_games ?? 0) < 65
    if (needsPrior && espnId) {
      try {
        const response = await fetchWithRetry(`${ESPN_CAREER_BASE_URL}/athletes/${espnId}/stats?seasontype=2`, undefined, { attemptTimeoutMs: 5000 })
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`ESPN career stats ${response.status}`)
        }
        payload = await response.json()
      } catch (error) { problems.push(errorMessage(error)) }
    }
    let years = player.years_exp
    const firstSeason = careerFirstSeasonYear(payload)
    if (years == null && firstSeason !== null && firstSeason <= currentSeasonYear(now)) years = currentSeasonYear(now) - firstSeason
    if (years == null && espnId) {
      try { years = await fetchEspnExperience(espnId, now) }
      catch (error) { problems.push(errorMessage(error)) }
    }
    if (player.nba_id && years == null) {
      try { years = (await fetchNbaCareerProfile(player.nba_id, now)).years }
      catch (error) { problems.push(errorMessage(error)) }
    }
    let changed = false
    const prior = needsPrior ? careerGamesPrior(payload) : null
    if (prior !== null) {
      const saved = await supabase.rpc('complete_player_career_prior_atomic', {
        p_player_id: player.id, p_prior: prior, p_espn_id: espnId ?? '', p_nba_id: player.nba_id ?? '',
      })
      if (saved.error) failures.push(`${player.id}: ${saved.error.message}`)
      else if (!saved.data) failures.push(`${player.id}: Player identity changed before prior update`)
      else changed = true
    }
    if (player.years_exp == null && years != null) {
      let query = supabase.from('players').update({ years_exp: years }).eq('id', player.id).is('years_exp', null)
      query = espnId ? query.eq('espn_id', espnId) : query.is('espn_id', null)
      if (player.nba_id) query = query.eq('nba_id', player.nba_id)
      const { data, error } = await query.select('id')
      if (error) failures.push(`${player.id}: ${error.message}`)
      else if (data?.length !== 1) failures.push(`${player.id}: Player identity changed before experience update`)
      else changed = true
    }
    if ((needsPrior && prior === null && (years == null || currentSeasonYear(now) - years < 2021)) || years == null) {
      unverified++
      console.warn(`[sync-players] career ${player.id}: ${[...problems, 'NBA career prior is unverified'].join('; ')}`)
    }
    if (changed) updated++
  }), 6)
  return { updated, unverified, failures }
}

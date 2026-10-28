import { supabase } from '../_shared/supabase.ts'
import { sourceBirthdate } from '../_shared/playerSourceDetails.ts'
import { normalizeName } from '../_shared/nameMatch.ts'
import { runBounded } from '../_shared/runBounded.ts'
import { errorMessage } from '../_shared/responses.ts'
import { workFetch } from '../_shared/workContext.ts'

export type BirthdatePlayer = {
  id: string; display_name: string | null; sleeper_id: string | null; espn_id: string | null; birthdate: string | null; nba_id?: string | null
}

export async function syncSourceBirthdates(players: BirthdatePlayer[], source: unknown[], budgetMs = 60000) {
  const dates = new Map<string, { birthdate: string; name: string; espnId: string | null }>()
  for (const value of source) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    const birthdate = sourceBirthdate(row.birth_date)
    if (row.sport !== 'nba' || typeof row.player_id !== 'string' || !/^\d+$/.test(row.player_id) || !birthdate) continue
    const name = normalizeName(`${typeof row.first_name === 'string' ? row.first_name : ''} ${typeof row.last_name === 'string' ? row.last_name : ''}`)
    if (dates.has(row.player_id)) throw new Error(`Duplicate Sleeper birthdate identity ${row.player_id}`)
    dates.set(row.player_id, { birthdate, name, espnId: row.espn_id == null ? null : String(row.espn_id) })
  }
  const targets = players.flatMap(player => {
    const date = player.sleeper_id ? dates.get(player.sleeper_id) : null
    if (player.birthdate !== null || !date || !date.name || normalizeName(player.display_name ?? '') !== date.name
      || (player.espn_id && date.espnId && player.espn_id !== date.espnId)) return []
    return [{ player, birthdate: date.birthdate }]
  })
  const deadline = performance.now() + Math.max(0, budgetMs)
  let updated = 0
  let deferred = 0
  const failures: string[] = []
  await runBounded(targets.map(({ player, birthdate }) => async () => {
    if (performance.now() >= deadline) { deferred++; return }
    try {
      const { data, error } = await supabase.from('players').update({ birthdate })
        .eq('id', player.id).eq('sleeper_id', player.sleeper_id!).eq('display_name', player.display_name!)
        .is('birthdate', null).select('id').abortSignal(AbortSignal.timeout(4000))
      if (error) throw error
      updated += data?.length ?? 0
      if (data?.length) player.birthdate = birthdate
    } catch (error) { failures.push(`Birthdate ${player.id}: ${errorMessage(error)}`) }
  }), 8)
  if (deferred) failures.push(`Birthdates: ${deferred} remaining after the time budget`)
  return { updated, failures }
}

async function profileBirthdate(player: BirthdatePlayer): Promise<string | null> {
  const errors: string[] = []
  if (player.espn_id) {
    try {
      const base = Deno.env.get('ESPN_CAREER_BASE_URL') ?? 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba'
      const response = await workFetch(`${base}/athletes/${encodeURIComponent(player.espn_id)}`, { signal: AbortSignal.timeout(4000) })
      if (response.status === 404) await response.body?.cancel()
      else {
        if (!response.ok) { await response.body?.cancel(); throw new Error(`ESPN profile ${response.status}`) }
        const payload = await response.json()
        if (payload.athlete && String(payload.athlete.id) !== player.espn_id) throw new Error('ESPN birthdate identity mismatch')
        const displayed = typeof payload.athlete?.displayDOB === 'string' ? payload.athlete.displayDOB.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/) : null
        const birthdate = sourceBirthdate(payload.athlete?.dateOfBirth) ?? (displayed
          ? sourceBirthdate(`${displayed[3]}-${displayed[2].padStart(2, '0')}-${displayed[1].padStart(2, '0')}`) : null)
        if (birthdate) return birthdate
      }
    } catch (error) { errors.push(errorMessage(error)) }
  }
  if (player.nba_id) {
    try {
      const base = Deno.env.get('NBA_COM_BASE_URL') ?? 'https://www.nba.com'
      const slug = (player.display_name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const response = await workFetch(`${base}/player/${encodeURIComponent(player.nba_id)}${slug ? `/${slug}` : ''}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nba.com/' }, signal: AbortSignal.timeout(4000),
      })
      if (response.status === 404) await response.body?.cancel()
      else {
        if (!response.ok) { await response.body?.cancel(); throw new Error(`NBA profile ${response.status}`) }
        const html = await response.text()
        const embedded = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
        const info = embedded ? JSON.parse(embedded[1])?.props?.pageProps?.player?.info : null
        if (info && String(info.PERSON_ID) !== player.nba_id) throw new Error('NBA birthdate identity mismatch')
        const birthdate = sourceBirthdate(info?.BIRTHDATE)
        if (birthdate) return birthdate
      }
    } catch (error) { errors.push(errorMessage(error)) }
  }
  if (errors.length) throw new Error(errors.join('; '))
  return null
}

export async function syncProfileBirthdates(players: BirthdatePlayer[], budgetMs: number, intervalMs = 500) {
  const deadline = performance.now() + Math.max(0, budgetMs)
  const targets = players.filter(player => player.birthdate === null && (player.nba_id || player.espn_id))
    .sort((a, b) => Number(Boolean(b.espn_id)) - Number(Boolean(a.espn_id)))
  let updated = 0
  let deferred = 0
  const failures: string[] = []
  let limited = false
  let next = performance.now()
  await runBounded(targets.map(player => async () => {
    const scheduled = Math.max(performance.now(), next)
    if (limited || scheduled >= deadline) { deferred++; return }
    next = scheduled + intervalMs
    const wait = Math.max(0, scheduled - performance.now())
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
    if (limited) { deferred++; return }
    try {
      const birthdate = await profileBirthdate(player)
      if (!birthdate) return
      let query = supabase.from('players').update({ birthdate }).eq('id', player.id).is('birthdate', null)
      query = player.nba_id ? query.eq('nba_id', player.nba_id) : query.eq('espn_id', player.espn_id!)
      const { data, error } = await query.select('id').abortSignal(AbortSignal.timeout(4000))
      if (error) throw error
      updated += data?.length ?? 0
      if (data?.length) player.birthdate = birthdate
    } catch (error) {
      const message = errorMessage(error)
      if (/NBA profile (403|429)|ESPN profile (403|429)/.test(message)) limited = true
      failures.push(`Birthdate ${player.id}: ${message}`)
    }
  }), 2)
  if (deferred) failures.push(`Birthdate profiles: ${deferred} remaining after ${limited ? 'the source limited requests' : 'the time budget'}`)
  return { updated, failures }
}

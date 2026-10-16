import { createFixtureResourceOwner } from './trade-fixture.mjs'

export async function ensureWebActionCalendar(fixture) {
  const year = fixture.currentSeason.season_year
  const result = await fixture.admin.from('season_weeks').select('week_number,week_start').eq('season_year', year).order('week_number')
  if (result.error) throw new Error(result.error.message)
  const existing = new Set(result.data.map((row) => row.week_number))
  const origin = result.data[0]
  const start = new Date(`${origin?.week_start ?? `${year - 1}-10-20`}T12:00:00Z`)
  const day = start.getUTCDay()
  start.setUTCDate(start.getUTCDate() + (day === 0 ? -6 : 1 - day) - ((origin?.week_number ?? 1) - 1) * 7)
  const rows = Array.from({ length: 26 }, (_, index) => {
    const first = new Date(start)
    first.setUTCDate(first.getUTCDate() + index * 7)
    const last = new Date(first)
    last.setUTCDate(last.getUTCDate() + 6)
    return { season_year: year, week_number: index + 1, week_start: first.toISOString().slice(0, 10), week_end: last.toISOString().slice(0, 10) }
  }).filter((row) => !existing.has(row.week_number))
  if (!rows.length) {
    await preparePlan(fixture)
    return
  }
  const inserted = await fixture.admin.from('season_weeks').insert(rows)
  if (inserted.error) throw new Error(inserted.error.message)
  const resources = createFixtureResourceOwner(fixture.admin)
  resources.registerCleanup('web action calendar', async () => {
    const result = await fixture.admin.from('season_weeks').delete().eq('season_year', year).in('week_number', rows.map((row) => row.week_number))
    if (result.error) throw new Error(result.error.message)
  })
  await preparePlan(fixture)
}

async function preparePlan(fixture) {
  const members = await fixture.admin.from('league_members').select('id').eq('league_id', fixture.league.id)
  if (members.error) throw new Error(members.error.message)
  if (members.data.length >= 10) return
  const count = 2
  const plan = await fixture.admin.from('leagues').update({ playoff_total_weeks: count, playoff_round_weeks: Array(count).fill(1) }).eq('id', fixture.league.id)
  if (plan.error) throw new Error(plan.error.message)
}

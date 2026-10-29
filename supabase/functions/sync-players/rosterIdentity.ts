import type { SourceLinkRecord } from '../_shared/sourceLinks.ts'

const rosterName = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '')
const team = (value: string) => ({ GS: 'GSW', SA: 'SAS', NO: 'NOP', NY: 'NYK', WSH: 'WAS', UTAH: 'UTA' }[value] ?? value)
type EspnRecord = { espn_id: string; first_name: string; last_name: string; nba_team: string | null }

export function corroborateRoster(nba: SourceLinkRecord[], espn: EspnRecord[]) {
  const key = (name: string, code: string) => `${rosterName(name)}:${team(code)}`
  const names = new Map<string, number>()
  for (const row of nba) names.set(key(row.display_name, row.nba_team), (names.get(key(row.display_name, row.nba_team)) ?? 0) + 1)
  const candidates = new Map<string, EspnRecord[]>()
  for (const row of espn) {
    if (!row.nba_team || !/^\d+$/.test(row.espn_id)) continue
    const name = key(`${row.first_name} ${row.last_name}`, row.nba_team)
    candidates.set(name, [...candidates.get(name) ?? [], row])
  }
  return nba.flatMap(row => {
    const name = key(row.display_name, row.nba_team)
    const matches = candidates.get(name) ?? []
    return /^\d+$/.test(row.provider_id) && names.get(name) === 1 && matches.length === 1
      ? [{ ...row, espn_id: matches[0].espn_id }] : []
  })
}

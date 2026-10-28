type NbaLinkRecord = {
  provider_id: string; display_name: string; nba_team: string; years_exp?: number | null; position?: string | null
  espn_id?: string; nba_id?: string; sleeper_id?: string
}

export type NbaLinkPlayer = {
  id: string; display_name: string | null; nba_id: string | null; nba_team: string | null
  espn_id: string | null; sleeper_id: string | null; years_exp: number | null
  position: string | null; eligible_positions: string[]
}

const identityName = (name: string | null) => (name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '')
const identityTeam = (team: string | null) => {
  const code = (team ?? '').trim().toUpperCase()
  return ({ SA: 'SAS', GS: 'GSW', NY: 'NYK', NO: 'NOP', NOR: 'NOP', PHO: 'PHX', WSH: 'WAS', UTAH: 'UTA', BRK: 'BKN', CHO: 'CHA' } as Record<string, string>)[code] ?? code
}
const identityKey = (name: string | null, team: string | null) => `${identityName(name)}:${identityTeam(team)}`

export function planNbaLinks(records: NbaLinkRecord[], players: NbaLinkPlayer[], currentRoster: boolean) {
  if (new Set(records.map(row => row.provider_id)).size !== records.length) throw new Error('Link nba players: Source identities must be unique.')
  const owners = new Map<string, NbaLinkPlayer[]>()
  const candidates = new Set<string>()
  for (const player of players) {
    if (player.nba_id) owners.set(player.nba_id, [...owners.get(player.nba_id) ?? [], player])
    else candidates.add(identityKey(player.display_name, player.nba_team))
  }
  const pending: { index: number; record: NbaLinkRecord }[] = []
  const completed: { index: number; player_id: string; action: string }[] = []
  for (const [index, record] of records.entries()) {
    const matches = owners.get(record.provider_id) ?? []
    const player = matches.length === 1 ? matches[0] : null
    if (!player || candidates.has(identityKey(record.display_name, record.nba_team))
      || (currentRoster && player.nba_team !== identityTeam(record.nba_team))
      || (player.years_exp == null && record.years_exp != null)
      || (player.position == null && record.position != null)
      || ((!player.eligible_positions || player.eligible_positions.length === 0) && record.position != null)
      || (record.espn_id != null && player.espn_id !== record.espn_id)
      || (record.sleeper_id != null && player.sleeper_id !== record.sleeper_id)
      || (record.nba_id != null && player.nba_id !== record.nba_id)) {
      pending.push({ index, record })
    } else completed.push({ index, player_id: player.id, action: 'unchanged' })
  }
  return { pending, completed }
}

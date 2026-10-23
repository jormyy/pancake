const seasonYear = date => Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 7 ? 1 : 0)

// The league-wide opening-night roster deadline precedes each season's first regular-season game, and each
// team's first box lists that roster, inactive players included. A synthetic first box proves nothing.
export function openingRosters(games, boxOf) {
  const openings = new Map()
  for (const game of games.filter(game => !game.rosterOnly).sort((a, b) => a.time.localeCompare(b.time))) {
    const year = seasonYear(game.date), opening = openings.get(year) ?? { date: game.date, teams: new Map() }
    openings.set(year, opening)
    const box = boxOf(game)
    for (const [code, team] of [[game.home, box.game.homeTeam], [game.away, box.game.awayTeam]]) {
      if (!opening.teams.has(code)) opening.teams.set(code, { gameId: game.id, date: game.date, people: game.provenance === 'SYNTHETIC' ? null : new Set(team.players.map(player => player.personId)) })
    }
  }
  return openings
}

// ESPN summaries carry no NBA person id and spell some names differently from NBA boxes (Luka Doncic / Luka Dončić,
// Jimmy Butler III / Jimmy Butler, RJ Davis / R.J. Davis, Jakob Poeltl / Jakob Pöltl, Yongxi Cui / Cui Yongxi). A name key
// ignores case, accents, punctuation, generational suffixes and word order.
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']), LETTERS = { ø: 'o', đ: 'd', ł: 'l', ß: 'ss', æ: 'ae', ı: 'i' }, UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue' }
const nameKey = name => name.normalize('NFD').replace(/\p{M}/gu, '').replace(/[øđłßæı]/g, letter => LETTERS[letter]).split(/[\s-]+/).map(word => word.replace(/[^a-z0-9]/g, '')).filter(word => word && !SUFFIXES.has(word)).sort().join(' ')
export function nameKeys(name) {
  const lower = String(name ?? '').normalize('NFC').toLowerCase()
  return new Set([lower, lower.replace(/[äöü]/g, letter => UMLAUTS[letter])].map(nameKey).filter(Boolean))
}

// A summary athlete links to a box player of the same game and team side: by exact name, otherwise by a name key that
// exactly one box player and no other unlinked athlete on that side carry. A box player links at most once.
function linkAthletes(players, athletes) {
  const links = athletes.map(athlete => players.find(player => player.name === athlete.displayName || player.name === athlete.fullName || `${player.firstName} ${player.familyName}` === athlete.displayName) ?? null)
  const claimed = new Set(links.filter(Boolean).map(player => player.personId)), keysOf = player => new Set([...nameKeys(player.name), ...nameKeys(`${player.firstName} ${player.familyName}`)])
  const open = athletes.map((athlete, index) => ({ index, keys: nameKeys(athlete.displayName) })).filter(row => !links[row.index])
  for (const row of open) {
    const shares = keys => [...keys].some(key => row.keys.has(key)), candidates = players.filter(player => shares(keysOf(player)))
    if (candidates.length !== 1 || claimed.has(candidates[0].personId) || open.some(other => other !== row && shares(other.keys))) continue
    links[row.index] = candidates[0]
    claimed.add(candidates[0].personId)
  }
  return links
}

// Each linked summary athlete is a dated observation of his box team; his first one makes him a person.
export function observeSide(people, game, code, players, athletes, firstYears = {}) {
  linkAthletes(players, athletes).forEach((match, index) => {
    if (!match) return
    const athlete = athletes[index], existing = people.get(String(athlete.id))
    const observation = { time: game.time, date: game.date, team: code, position: athlete.position?.abbreviation ?? match.position ?? null, yearsExp: athlete.experience?.years ?? null, rosterOnly: game.rosterOnly === true }
    if (existing) existing.observations.push(observation)
    else people.set(String(athlete.id), { id: String(athlete.id), firstName: match.firstName, lastName: match.familyName, fullName: match.name, nbaId: match.personId, fromYear: firstYears[String(match.personId)] ?? null, observations: [observation] })
  })
}

// A real NBA box lists its team's game roster, inactive players included, and a player who has just changed teams is
// listed by his new team (INACTIVE_TRADE) before he dresses; ESPN summaries list only the players who dressed. A real box
// dated D that lists a known person for a team other than his latest observed one is a dated observation of that team
// from D. A box never introduces a person.
export function boxTransfers(people, game, box) {
  if (game.rosterOnly || game.provenance === 'SYNTHETIC') return []
  const aliases = new Map(), moves = []
  for (const person of people.values()) aliases.set(person.nbaId, [...(aliases.get(person.nbaId) ?? []), person])
  for (const [code, team] of [[game.home, box.game.homeTeam], [game.away, box.game.awayTeam]]) {
    for (const player of team.players) {
      const latest = (aliases.get(player.personId) ?? []).flatMap(person => person.observations.filter(item => (item.time ?? item.date) <= game.time).map(observation => ({ person, observation })))
        .sort((a, b) => (a.observation.time ?? a.observation.date).localeCompare(b.observation.time ?? b.observation.date)).at(-1)
      if (!latest || latest.observation.team === code) continue
      latest.person.observations.push({ time: game.time, date: game.date, team: code, position: latest.observation.position, yearsExp: latest.observation.yearsExp, rosterOnly: false })
      moves.push({ nbaId: player.personId, espnId: latest.person.id, from: latest.observation.team, to: code, date: game.date, gameId: game.id, reason: player.notPlayingReason ?? null })
    }
  }
  return moves
}

// From each season's opener on, a dated observation older than the opener (a camp box or an earlier season) holds only
// while that team's opening-night box lists the player.
function supersedingBox(person, observation, date, openings) {
  return [...openings.values()].map(opening => observation.date < opening.date && opening.date <= date ? opening.teams.get(observation.team) : null).find(team => team?.people?.has(person.nbaId) === false) ?? null
}
const superseded = (person, observation, date, openings = new Map()) => supersedingBox(person, observation, date, openings) != null

export function rosterForDate(people, date, openings = new Map()) {
  const year = seasonYear(date)
  const groups=new Map()
  for(const person of people){
    const observations=person.observations.filter(item=>item.date<=date&&!superseded(person,item,date,openings))
    if(!observations.length)continue
    if(observations.every(row=>row.rosterOnly)&&(person.fromYear==null||person.fromYear>year))continue
    const key=String(person.nbaId),group=groups.get(key)??[]
    group.push({...person,observations})
    groups.set(key,group)
  }
  return [...groups.values()].map(group=>{
    group.sort((a,b)=>(a.observations[0].time??a.observations[0].date).localeCompare(b.observations[0].time??b.observations[0].date)||a.id.localeCompare(b.id))
    const person=group[0],observations=group.flatMap(row=>row.observations).sort((a,b)=>(a.time??a.date).localeCompare(b.time??b.date)),observation=observations.at(-1)
    const years = person.fromYear == null ? observation.yearsExp ?? null : Math.max(0, year - person.fromYear)
    return { ...person,observations,sourceAliases:group.map(row=>row.id),team: observation.team, position: { abbreviation: observation.position }, experience: { years }, status: { type: observation.date >= `${year}-07-01` ? 'active' : 'inactive' } }
  })
}
export function playerIndexAt(people, date, openings = new Map()) {
  return { resultSets: [{ headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: rosterForDate(people, date, openings).map(player => [player.nbaId, player.firstName, player.lastName, Number(player.status.type === 'active')]) }] }
}

export function rosterSourceAudit(people, date, openings = new Map()) {
  const roster = rosterForDate(people, date, openings), byPerson = new Map()
  for (const person of people) {
    const row = byPerson.get(person.nbaId) ?? { nbaId: person.nbaId, name: person.fullName, fromYear: person.fromYear, observed: false, superseded: [] }
    row.observed ||= person.observations.some(item => item.date <= date)
    for (const item of person.observations.filter(item => item.date <= date)) {
      const box = supersedingBox(person, item, date, openings)
      if (box) row.superseded.push({ team: item.team, date: item.date, camp: item.rosterOnly === true, openingBox: box.gameId })
    }
    byPerson.set(person.nbaId, row)
  }
  const missing = [...byPerson.values()].filter(row => row.observed && !roster.some(player => player.nbaId === row.nbaId))
  return {
    served: roster.length,
    aliases: roster.filter(row => row.sourceAliases.length > 1).map(row => ({ nbaId: row.nbaId, selectedEspnId: row.id, aliases: row.sourceAliases })),
    unserved: missing.map(row => ({ nbaId: row.nbaId, name: row.name, fromYear: row.fromYear, reason: row.superseded.length ? 'Dated roster observations superseded by opening-night boxes that do not list him' : 'Only preseason observations without a prior/current NBA career in the pinned registry' })),
    superseded: [...byPerson.values()].filter(row => row.superseded.length).map(row => ({ nbaId: row.nbaId, name: row.name, observations: row.superseded, servedAs: roster.find(player => player.nbaId === row.nbaId)?.team ?? null })),
    openingRosters: [...openings].map(([year, opening]) => ({ year, date: opening.date, teams: opening.teams.size, unproven: [...opening.teams].filter(([, team]) => team.people == null).map(([code]) => code) })),
  }
}

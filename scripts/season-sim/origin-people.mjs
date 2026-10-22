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

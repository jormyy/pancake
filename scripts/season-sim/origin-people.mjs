export function rosterForDate(people, date) {
  const year = Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 7 ? 1 : 0)
  const groups=new Map()
  for(const person of people){
    const observations=person.observations.filter(item=>item.date<=date)
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

export function playerIndexAt(people, date) {
  return { resultSets: [{ headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: rosterForDate(people, date).map(player => [player.nbaId, player.firstName, player.lastName, Number(player.status.type === 'active')]) }] }
}

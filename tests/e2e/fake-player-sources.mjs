const teams = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS']

export function fakePlayerSourceResponse(url, state) {
  if (!url.pathname.endsWith('/staticData/playerIndex.json') && !url.pathname.startsWith('/espn')) return null
  const players = [...state.players.values(), ...Array.from({ length: 360 }, (_, index) => ({
    player_id: String(600000 + index), first_name: 'Synthetic', last_name: `Veteran${String.fromCharCode(65 + Math.floor(index / 26), 65 + index % 26)}`,
    full_name: `Synthetic Veteran${String.fromCharCode(65 + Math.floor(index / 26), 65 + index % 26)}`, team: teams[index % teams.length], position: 'SG',
    years_exp: state.seasonYear - 2023, active: true, injury_status: index === 0 ? 'Out' : null,
  }))]
  const athlete = player => ({ id: player.player_id, firstName: player.first_name, lastName: player.last_name,
    fullName: player.full_name, displayName: player.full_name, position: { abbreviation: player.position },
    team: { abbreviation: player.team }, status: { type: player.active ? 'active' : 'inactive' },
    experience: { years: player.years_exp }, dateOfBirth: `${state.seasonYear - (player.age ?? state.seasonYear - 2002)}-01-01T00:00Z`,
  })
  if (url.pathname.endsWith('/staticData/playerIndex.json')) return { resultSets: [{
    name: 'PlayerIndex',
    headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS', 'TEAM_ABBREVIATION', 'POSITION', 'FROM_YEAR', 'DRAFT_YEAR'],
    rowSet: players.map(player => [Number(player.player_id), player.first_name, player.last_name,
      player.active ? 1 : 0, player.team, player.position, state.seasonYear - 1 - player.years_exp, state.seasonYear - 1 - player.years_exp]),
  }] }
  if (url.pathname === '/espn/teams') return { sports: [{ leagues: [{ teams: teams.map((team, index) => ({ team: { id: String(index + 1), abbreviation: team } })) }] }] }
  const roster = url.pathname.match(/^\/espn\/teams\/(\d+)\/roster$/)
  if (roster && teams[Number(roster[1]) - 1]) return {
    season: { year: state.seasonYear }, athletes: players.filter(player => player.team === teams[Number(roster[1]) - 1]).map(athlete),
  }
  if (url.pathname === '/espn/injuries') return { injuries: teams.map(team => ({
    team: { abbreviation: team }, injuries: players.filter(player => player.team === team && player.injury_status)
      .map(player => ({ status: player.injury_status, athlete: athlete(player) })),
  })) }
  if (url.pathname === '/espn/news') return { articles: [] }
  if (url.pathname === '/espn-search') return { items: players.filter(player => player.full_name === url.searchParams.get('query'))
    .map(player => ({ id: player.player_id, displayName: player.full_name, type: 'player', league: 'nba' })) }
  const career = url.pathname.match(/^\/espn-career\/athletes\/(\d+)(\/stats)?$/)
  const player = career && players.find(player => player.player_id === career[1])
  if (player && career[2]) {
    const statistics = Array.from({ length: player.years_exp }, (_, index) => ({ season: { year: state.seasonYear - 1 - index }, stats: ['82'] }))
    return { filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
      categories: [{ names: ['gamesPlayed'], totals: [String(statistics.length * 82)], statistics }] }
  }
  if (player) {
    const season = player.years_exp + 1
    const suffix = season % 100 >= 11 && season % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[season % 10] ?? 'th')
    return { league: { slug: 'nba' }, athlete: { ...athlete(player),
      displayExperience: player.years_exp === 0 ? 'Rookie' : `${season}${suffix} Season`,
    } }
  }
  return null
}

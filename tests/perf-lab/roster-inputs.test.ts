import { expect, it } from 'vitest'
import { rosterInputCounts } from '../../scripts/perf-lab/roster-inputs.mjs'

it('retains dated roster observations from games before the setup day', async () => {
  const dates = ['2025-10-21', '2025-10-22']
  const teams = ['BOS', 'LAL', 'NYK', 'CLE']
  const games = dates.map((date, index) => ({ id: String(index), espnId: String(index), date, time: `${date}T20:00:00Z`, home: teams[index * 2], away: teams[index * 2 + 1] }))
  const people = teams.map((team, index) => ({ personId: index + 1, firstName: team, familyName: 'Player', name: `${team} Player`, position: 'PG' }))
  const store = { json: async (key: string) => {
    const index = Number(key.split('-').at(-1))
    if (key.startsWith('boxscore')) return { game: { homeTeam: { teamTricode: teams[index * 2], players: [people[index * 2]] }, awayTeam: { teamTricode: teams[index * 2 + 1], players: [people[index * 2 + 1]] } } }
    return { boxscore: { players: [index * 2, index * 2 + 1].map(player => ({ team: { abbreviation: teams[player] }, statistics: [{ athletes: [{ athlete: { id: String(player + 10), displayName: people[player].name, fullName: people[player].name, position: { abbreviation: 'PG' } } }] }] })) } }
  } }
  expect(await rosterInputCounts(games.slice(1), store)).toEqual({ '2025-10-22': 2 })
  expect(await rosterInputCounts(games, store)).toEqual({ '2025-10-21': 2, '2025-10-22': 4 })
})

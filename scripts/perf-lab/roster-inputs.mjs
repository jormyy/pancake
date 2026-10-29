import { boxTransfers, observeSide, openingRosters, rosterForDate } from '../season-sim/origin-people.mjs'
import { teamCode } from '../season-sim/common.mjs'

export async function rosterInputCounts(games, store) {
  const people = new Map(), boxes = new Map()
  for (const game of [...games].sort((a, b) => a.time.localeCompare(b.time))) {
    const box = await store.json(`boxscore-${game.id}`)
    boxes.set(game.id, box)
    const summary = await store.json(`summary-${game.espnId}`)
    for (const side of summary.boxscore?.players ?? []) {
      const code = teamCode(side.team.abbreviation)
      const team = [box.game.homeTeam, box.game.awayTeam].find(row => row.teamTricode === code)
      observeSide(people, game, code, team?.players ?? [], (side.statistics ?? []).flatMap(group => group.athletes ?? []).map(row => row.athlete))
    }
    boxTransfers(people, game, box)
  }
  const openings = openingRosters(games, game => boxes.get(game.id))
  return Object.fromEntries([...new Set(games.map(game => game.date))].sort().map(date => [date, rosterForDate([...people.values()], date, openings).length]))
}

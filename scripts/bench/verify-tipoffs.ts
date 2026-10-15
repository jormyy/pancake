import { Game, player, randomAt } from './fixture.ts'
import { State, Stored, validate } from './oracle.ts'

const [evidence, ...labels] = Deno.args
if (!evidence || !labels.length) throw new Error('Pass the evidence directory and NEW result labels.')
const games: Game[] = JSON.parse(await Deno.readTextFile(`${evidence}/schedule.json`))
const dates = [...new Set(games.map((game) => game.date))]
const windows = [...new Set(games.filter((game) => !game.postponed).map((game) => game.time))]
const roster = Array.from({ length: 100 }, (_, index) => player(index))
const news: { time: number; date: string; playerId: string; projection?: number }[] = []
for (const [index, time] of windows.entries()) {
  const windowGames = games.filter((game) => game.time === time && !game.postponed)
  const participants = roster.filter((p) => windowGames.some((game) => game.home === p.team || game.away === p.team))
  if (!participants.length) continue
  if (index % 3 === 0) news.push({ time: Date.parse(time) - 3 * 60000, date: windowGames[0].date,
    playerId: participants[randomAt(index, 3) % participants.length].id, projection: 50 + randomAt(index, 4) % 2000 / 100 })
  if (index % 7 === 0) news.push({ time: Date.parse(time) + 5 * 60000, date: windowGames[0].date,
    playerId: participants[randomAt(index, 7) % participants.length].id })
}
news.sort((a, b) => a.time - b.time)
for (const label of labels) {
  const result = JSON.parse(await Deno.readTextFile(`${evidence}/${label}-result.json`))
  const snapshots: { time: string; rows: Stored[] }[] = JSON.parse(await Deno.readTextFile(`${evidence}/${label}-snapshots.json`))
  if (result.side !== 'new' || result.smoke || snapshots.length !== windows.length) throw new Error('Exact-tipoff proof requires a complete NEW season.')
  let exact: { time: string; rows: Stored[] }[] = []
  try { exact = JSON.parse(await Deno.readTextFile(`${evidence}/${label}-exact-snapshots.json`)) } catch { exact = [] }
  const latestAtTipoff = result.exactTipoffs === windows.length && exact.length === windows.length
  if (result.exactTipoffs && !latestAtTipoff) throw new Error('Exact-tipoff evidence is missing or incomplete.')
  let checks = 0
  const laterNews: { time: string; error: string; postponed: string[] }[] = []
  for (const [index, time] of windows.entries()) {
    const timestamp = Date.parse(time)
    const date = games.find((game) => game.time === time)!.date
    const day = dates.indexOf(date)
    const snapshot = snapshots[index]
    if (Date.parse(snapshot.time) !== timestamp - 60000 || snapshot.rows.some((row) => row.game_date !== date)) throw new Error('Saved database rows do not match the pre-tipoff observation.')
    const today = games.filter((game) => game.date === date)
    const stateAt = (availableAt: number): State => {
      const state: State = {
        injury: new Map(roster.map((p, i) => [p.id, randomAt(day + 1000, i) % 13 === 0 ? 'Out' : null])),
        projections: new Map(roster.map((p, i) => [p.id, 5 + randomAt(day, i) % 4500 / 100])),
        playing: new Set(today.filter((game) => !game.postponed || availableAt < Date.parse(game.time) - 30 * 60000).flatMap((game) => [game.home, game.away])),
        locked: new Set(roster.filter((p) => today.some((game) => Date.parse(game.time) <= timestamp && (game.home === p.team || game.away === p.team))).map((p) => p.id)),
      }
      for (const event of news.filter((event) => event.date === date && event.time <= availableAt)) {
        state.injury.set(event.playerId, 'Out')
        if (event.projection !== undefined) state.projections.set(event.playerId, event.projection)
      }
      return state
    }
    checks += validate(snapshot.rows, stateAt(timestamp - 60000), snapshot.rows, true)
    if (latestAtTipoff) {
      if (Date.parse(exact[index].time) !== timestamp) throw new Error('Exact-tipoff snapshot time differs from its game.')
      checks += validate(exact[index].rows, stateAt(timestamp), snapshot.rows, true)
      continue
    }
    try { validate(snapshot.rows, stateAt(timestamp), snapshot.rows, true) } catch (error) {
      const postponed = today.filter((game) => game.postponed && Date.parse(game.time) - 30 * 60000 > timestamp - 60000 && Date.parse(game.time) - 30 * 60000 <= timestamp).map((game) => game.sourceId)
      if (!postponed.length) throw error
      laterNews.push({ time, error: String(error), postponed })
    }
  }
  const proof = { label, tipoffs: windows.length, teams: new Set(roster.map((p) => p.memberId)).size, checks,
    latestAtTipoff, laterNews, source: latestAtTipoff ? 'Stored database rows at every pre-tipoff observation and exact tipoff pass the independent oracle with the latest inputs and locks.' : 'Legacy pre-tipoff snapshots pass with snapshot inputs and exact locks. Later news is reported separately.' }
  await Deno.writeTextFile(`${evidence}/${label}-tipoff-replay-proof.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof))
}

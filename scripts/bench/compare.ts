import { connect } from './request-driver.ts'
import { Game, player, randomAt } from './fixture.ts'

const evidence = Deno.args[0]
const labels = Deno.args.slice(1)
if (!evidence || labels.length < 2) throw new Error('Pass evidence directory and result labels.')
const sql = connect(Deno.env.get('SUPABASE_DB_URL') ?? 'postgresql://postgres:postgres@127.0.0.1:56322/postgres')
const games: Game[] = JSON.parse(await Deno.readTextFile(`${evidence}/schedule.json`))
const dates = [...new Set(games.map((game) => game.date))]
const windows = [...new Set(games.filter((g) => !g.postponed).map((g) => g.time))]
const news: { playerId: string; date: string; time: number }[] = []
for (const [index, time] of windows.entries()) {
  const windowGames = games.filter((g) => g.time === time && !g.postponed)
  const participants = Array.from({ length: 100 }, (_, i) => player(i)).filter((p) => windowGames.some((g) => g.home === p.team || g.away === p.team))
  for (const [divisor, offset, randomKey] of [[3, -3, 3], [7, 5, 7]]) {
    if (index % divisor === 0 && participants.length) {
      const p = participants[randomAt(index, randomKey) % participants.length]
      news.push({ playerId: p.id, date: windowGames[0].date, time: new Date(time).getTime() + offset * 60000 })
    }
  }
}
const points = games.filter((g) => !g.postponed).flatMap((game) => {
  const day = dates.indexOf(game.date)
  return Array.from({ length: 100 }, (_, i) => {
    const p = player(i)
    const out = randomAt(day + 1000, i) % 13 === 0 || news.some((n) => n.playerId === p.id && n.date === game.date && n.time <= new Date(game.time).getTime() + 5 * 60000)
    return { player_id: p.id, game_date: game.date,
      points: p.team === game.home || p.team === game.away ? out ? 0 : Math.max(0, 5 + randomAt(day, i) % 4500 / 100 + (randomAt(day + 3000, i) % 1001 - 500) / 100) : null }
  }).filter((p) => p.points !== null)
})
const outputs = []
const lineupSets = new Map<string, Set<string>>()
for (const label of labels) {
  const rows = JSON.parse(await Deno.readTextFile(`${evidence}/${label}-lineups.json`))
  const [score] = await sql`WITH lineups AS (
    SELECT * FROM jsonb_to_recordset(${sql.json(rows)}) AS l(member_id uuid,player_id uuid,slot_type text,game_date date)
  ), points AS (
    SELECT * FROM jsonb_to_recordset(${sql.json(points)}) AS p(player_id uuid,game_date date,points numeric)
  ) SELECT count(*)::int AS starters,round(COALESCE(sum(points.points),0),2)::numeric AS points FROM lineups LEFT JOIN points USING(player_id,game_date)`
  outputs.push({ label, ...score })
  lineupSets.set(label, new Set(rows.map((row: { member_id: string; player_id: string; slot_type: string; game_date: string }) => `${row.game_date}:${row.member_id}:${row.player_id}:${row.slot_type}`)))
}
const base = lineupSets.get(labels[0])!
const comparison = { results: outputs, differences: labels.slice(1).map((label) => ({ label,
  added: [...lineupSets.get(label)!].filter((row) => !base.has(row)).length,
  removed: [...base].filter((row) => !lineupSets.get(label)!.has(row)).length,
})), scoring: 'Fixed seeded realized points; baseline and late injury news through tipoff plus five minutes yield zero. League scoring awards one point per point.' }
await Deno.writeTextFile(`${evidence}/comparison.json`, JSON.stringify(comparison, null, 2))
await Deno.writeTextFile(`${evidence}/realized-points.json`, JSON.stringify(points))
console.log(JSON.stringify(comparison, null, 2))
await sql.end()

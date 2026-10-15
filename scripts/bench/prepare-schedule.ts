import type { Game } from './fixture.ts'

const evidence = Deno.args[0]
if (!evidence) throw new Error('Pass the evidence directory.')
const months = ['202510', '202511', '202512', '202601', '202602', '202603', '202604']
const teams = new Set('ATL BOS BKN CHA CHI CLE DAL DEN DET GS HOU IND LAC LAL MEM MIA MIL MIN NO NY OKC ORL PHI PHX POR SAC SA TOR UTAH WSH'.split(' '))
const games: Game[] = []
for (const month of months) {
  const path = `${evidence}/schedule-${month}.json`
  let text
  try { text = await Deno.readTextFile(path) } catch {
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${month}&limit=1000`)
    if (!response.ok) throw new Error(`Schedule failed: ${response.status}`)
    text = await response.text()
    await Deno.writeTextFile(path, text)
  }
  for (const event of JSON.parse(text).events) {
    const competition = event.competitions[0]
    if (event.season.type !== 2 || !competition.competitors.every((c: { team: { abbreviation: string } }) => teams.has(c.team.abbreviation))) continue
    if (competition.notes?.some((note: { headline: string }) => note.headline === 'NBA Cup Championship')) continue
    games.push({
      sourceId: event.id, time: new Date(event.date).toISOString(),
      date: new Date(event.date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
      home: competition.competitors.find((c: { homeAway: string }) => c.homeAway === 'home').team.abbreviation,
      away: competition.competitors.find((c: { homeAway: string }) => c.homeAway === 'away').team.abbreviation,
      postponed: event.status.type.name === 'STATUS_POSTPONED',
    })
  }
}
games.sort((a, b) => a.time.localeCompare(b.time) || a.sourceId.localeCompare(b.sourceId))
if (games.filter((g) => !g.postponed).length !== 1230 || games.filter((g) => g.postponed).length !== 4) throw new Error('Incomplete season.')
const counts = Object.fromEntries([...teams].map((team) => [team, games.filter((game) => !game.postponed && (game.home === team || game.away === team)).length]))
if (Object.values(counts).some((count) => count !== 82)) throw new Error('A team does not have its full regular season.')
await Deno.writeTextFile(`${evidence}/schedule-summary.json`, JSON.stringify({ playedGames: games.filter((g) => !g.postponed).length, postponedEntries: games.filter((g) => g.postponed).length, gamesPerTeam: counts }, null, 2))
await Deno.writeTextFile(`${evidence}/schedule.json`, JSON.stringify(games, null, 2))
console.log(`${games.length} schedule entries; 1230 played games, four postponed entries.`)

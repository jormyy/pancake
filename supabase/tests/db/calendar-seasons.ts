import assert from 'node:assert/strict'
import { buildScheduleSyncPlan } from '../../functions/_shared/schedule.ts'
import { resolveSeasonWeekNumber } from '../../functions/_shared/weekPolicy.ts'

const selected = Deno.env.get('POST_CALENDAR_CASE')
const cases = selected ? [selected] : ['opening', 'all-star', 'cup', 'postponed-status']
for (const testCase of cases) {
  for (const start of [2024, 2025]) {
    const fixture = JSON.parse(await Deno.readTextFile(new URL(`../../../tests/fixtures/calendar/espn-${start}-${start + 1}.json`, import.meta.url)))
    const plan = buildScheduleSyncPlan(fixture.games, new Date(`${start}-10-01T00:00:00Z`))
    if (testCase === 'opening') {
      const opening = start === 2024 ? '2024-10-22' : '2025-10-21'
      assert.equal(plan.seasonStart, opening, 'Opening night is the first regular-season day, even with two games')
      assert.equal(plan.rows.filter(game => game.game_date === opening).length, 2)
      assert.deepEqual(plan.weeks[0], { season_year: start + 1, week_number: 1, week_start: opening, week_end: `${start}-10-${start === 2024 ? '27' : '26'}` })
      assert.ok(plan.rows.filter(game => game.game_date === opening).every(game => game.week_number === 1))
      console.log(JSON.stringify({ case: testCase, provenance: fixture.provenance, season: start + 1, opening, firstGames: fixture.games.filter((game: { gameDate: string }) => game.gameDate === opening) }))
    }
    if (testCase === 'all-star') {
      const first = start === 2024 ? '2025-02-10' : '2026-02-09'
      const last = start === 2024 ? '2025-02-23' : '2026-02-22'
      assert.deepEqual(plan.weeks.find(week => week.week_number === 17), { season_year: start + 1, week_number: 17, week_start: first, week_end: last }, 'The two NBA weeks around the no-game break form one fantasy week')
      assert.equal(plan.weeks.length, 24)
      assert.equal(resolveSeasonWeekNumber(plan.weeks, first, 'exact'), 17)
      assert.equal(resolveSeasonWeekNumber(plan.weeks, last, 'exact'), 17)
      assert.equal(resolveSeasonWeekNumber(plan.weeks, start === 2024 ? '2025-02-17' : '2026-02-16', 'exact'), 17)
      assert.equal(plan.weeks[19].week_start, start === 2024 ? '2025-03-10' : '2026-03-09')
      for (const day of [`${start}-11-${start === 2024 ? '28' : '27'}`, `${start}-12-24`, `${start}-12-${start === 2024 ? '17' : '16'}`]) {
        const before = plan.rows.filter(game => game.game_date < day).at(-1)!
        const after = plan.rows.find(game => game.game_date > day)!
        assert.ok(after.week_number - before.week_number <= 1, 'One empty day cannot merge NBA weeks')
      }
      const syntheticSunday = start === 2024 ? '2024-11-24' : '2025-11-23'
      const synthetic = buildScheduleSyncPlan(fixture.games.filter((game: { gameDate: string }) => game.gameDate !== syntheticSunday), new Date(`${start}-10-01T00:00:00Z`))
      assert.equal(Reflect.get(synthetic.rows[0], 'schedule_complete'), false, 'A partial caller cannot attest a complete source snapshot from game count alone')
      assert.equal(synthetic.weeks.length, 24, 'SYNTHETIC missing Sunday: one empty day across Monday must not create a second merged week')
      console.log(JSON.stringify({ case: testCase, season: start + 1, weeks: plan.weeks }))
    }
    if (testCase === 'cup') {
      const final = fixture.games.find((game: { cupFinal: boolean }) => game.cupFinal)
      assert.ok(final)
      assert.equal(plan.rows.some(game => game.nba_game_id === final.gameId), false)
      const cupGames = fixture.games.filter((game: { cupFinal: boolean; notes: { headline?: string }[] }) => !game.cupFinal && game.notes.some(note => /cup/i.test(note.headline ?? '')))
      assert.ok(cupGames.length >= 2)
      for (const game of cupGames) assert.ok(plan.rows.some(row => row.nba_game_id === game.gameId))
      const controls = ['001-test', '003-test', '004-test', '005-test', '006-test'].map(gameId => ({ ...fixture.games[0], gameId }))
      assert.equal(buildScheduleSyncPlan([...fixture.games, ...controls], new Date(`${start}-10-01T00:00:00Z`)).rows.length, plan.rows.length)
      console.log(JSON.stringify({ case: testCase, season: start + 1, excludedFinal: final, countedCupGames: cupGames.length }))
    }
  }
  if (testCase === 'postponed-status') {
    const originalFetch = globalThis.fetch
    globalThis.fetch = () => Promise.resolve(Response.json({ leagueSchedule: { seasonYear: '2025-26', gameDates: [{ games: [{ gameId: '0022500520', gameDateEst: '2026-01-08T00:00:00Z', gameStatus: 1, gameStatusText: '', postponedStatus: 'Y', homeTeam: { teamTricode: 'CHI' }, awayTeam: { teamTricode: 'MIA' } }] }] } }))
    try {
      const { fetchSeasonSchedule } = await import('../../functions/_shared/nba.ts')
      const [game] = await fetchSeasonSchedule()
      assert.match(game.statusText ?? '', /postpon/i, 'NBA postponedStatus must survive blank display text')
      console.log('PASS SYNTHETIC NBA postponedStatus parser control')
    } finally { globalThis.fetch = originalFetch }
  }
}
Deno.exit(0)

import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, rows, sql } from './notif-t9-support.ts'

const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
const event = 'season_started'
try {
  await clock.start('2026-10-20T16:00:00Z')
  await fixture.init()
  await transport.start()
  const normal = await fixture.league()
  const delayed = await fixture.league()
  await sql(`UPDATE league_seasons SET skipped_weeks=ARRAY[1] WHERE id=${q(delayed.season)}`)
  for (const league of [normal, delayed]) {
    await fixture.game(league.year, '2026-10-20', 1)
    await fixture.game(league.year, '2026-10-23', 1)
    await fixture.game(league.year, '2026-10-27', 2)
    await fixture.game(league.year, '2026-10-19', 1, '001')
    await fixture.game(league.year, '2026-10-19', 1, '006')
  }
  assert.equal(await sql(`SELECT count(*) FROM league_seasons WHERE id IN (${q(normal.season)},${q(delayed.season)}) AND regular_season_start IS NOT NULL`), '0')
  const scope = (season: string) => `data->>'leagueSeasonId'=${q(season)}`
  await clock.scan('2026-10-19T16:00:00Z')
  assert.equal((await rows(event, scope(normal.season))).length, 0, 'No start before opening night, even with preseason/Cup-final games')
  await clock.scan('2026-10-20T03:59:00Z')
  assert.equal((await rows(event, scope(normal.season))).length, 0, 'America/New_York day boundary applies')
  await clock.scan('2026-10-20T16:00:00Z')
  const opening = await expectRows(event, scope(normal.season), normal.members, () => sql(clock.minute))
  assert.equal((await rows(event, scope(delayed.season))).length, 0, 'The same users in a skipped-week league receive no opening alert there')
  await transport.prove(fixture, opening, 'supabase/tests/db/notif-t9-season.ts:29')
  await clock.scan('2026-10-21T16:00:00Z')
  assert.equal((await rows(event, scope(normal.season))).length, 4, 'Next-day scan cannot repeat a start')
  const midseason = await fixture.league()
  await fixture.game(midseason.year, '2026-10-20', 1)
  await fixture.game(midseason.year, '2026-10-23', 1)
  await clock.scan('2026-10-23T16:00:00Z')
  assert.equal((await rows(event, scope(midseason.season))).length, 0, 'Mid-season deployment cannot backfill season-start alerts')
  assert.equal((await rows(event, scope(normal.season))).length, 4)
  await clock.scan('2026-10-26T16:00:00Z')
  assert.equal((await rows(event, scope(delayed.season))).length, 0, 'Week start without an NBA game is not a scoring day')
  await clock.scan('2026-10-27T16:00:00Z')
  const delayedStart = await expectRows(event, scope(delayed.season), delayed.members, () => sql(clock.minute))
  await transport.prove(fixture, delayedStart, 'supabase/tests/db/notif-t9-season.ts:42')
  await clock.scan('2026-10-28T16:00:00Z')
  assert.equal((await rows(event, scope(delayed.season))).length, 4)
  assert.equal((await rows(event, scope(midseason.season))).length, 0)
  console.log('SYNTHETIC: production minute entry, schedule-derived first scoring day, skipped week, ET boundary, same-day and next-day dedupe, mid-season negative, send-time switches, local Expo receipts')
} finally {
  await transport.close()
  await fixture.cleanup()
  await clock.restore()
}

import { ensureWebActionCalendar } from './web-targets-action-calendar.mjs'
import assert from 'node:assert/strict'
import { setupTradeGameplayFixture } from './trade-fixture.mjs'

export async function auditWebMockActions({ check, env, season, page, press, button, open, signIn, db, wait, inspect }) {
  for (const kind of ['auction', 'snake']) await check(`mock-${kind}-room-lifecycle`, async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const initialRoster = await db(fixture.admin.from('roster_players').select('id').eq('league_id', fixture.league.id).order('id'))
    const rooms = () => db(fixture.admin.from('drafts').select('id,status,scheduled_at,room_name,draft_type').eq('league_id', fixture.league.id).eq('is_mock', true))
    const members = (id) => db(fixture.admin.from('draft_room_members').select('member_id').eq('draft_id', id))
    await ensureWebActionCalendar(fixture)
    await signIn(fixture)
    const completed = []
    for (const scheduled of [false, true]) {
      const name = `Web ${kind} ${scheduled ? 'scheduled' : 'now'} ${fixture.runId}`
      await open('/league?tab=mockRooms')
      await page.getByRole('textbox', { name: 'Mock room name', exact: true }).fill(name)
      await press(page.getByRole('radio', { name: kind === 'auction' ? 'Auction room' : 'Rookie room', exact: true }))
      const time = page.getByRole('textbox', { name: 'Mock room start time', exact: true })
      const requested = await page.evaluate((scheduled) => {
        const date = new Date(Date.now() + (scheduled ? 86400_000 : -60_000))
        const pad = (value) => String(value).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      }, scheduled)
      await time.fill(requested)
      await inspect()
      await press(button('Create mock draft room'))
      await wait(async () => (await rooms()).some((room) => room.room_name === name))
      const room = (await rooms()).find((room) => room.room_name === name)
      assert.equal(room.draft_type, kind)
      assert.equal((await members(room.id)).length, 1)
      if (scheduled) assert.ok(Date.parse(room.scheduled_at) > Date.now())
      else assert.ok(Date.parse(room.scheduled_at) <= Date.now())
      if (!scheduled) assert.equal(await page.getByRole('button', { name: new RegExp(`^Start ${name}`) }).isDisabled(), true)
      await signIn(fixture, 1)
      await open('/league?tab=mockRooms')
      await press(button(`Join ${name}`))
      await wait(async () => (await members(room.id)).length === 2)
      await press(button(`Leave ${name}`))
      await wait(async () => (await members(room.id)).length === 1)
      await press(button(`Join ${name}`))
      await wait(async () => (await members(room.id)).length === 2)
      await signIn(fixture)
      if (scheduled) await db(fixture.admin.from('drafts').update({ scheduled_at: new Date(Date.now() - 1000).toISOString() }).eq('id', room.id))
      await open('/league?tab=mockRooms')
      await press(button(`Start ${name}`))
      await page.waitForURL((url) => url.pathname === (kind === 'auction' ? '/draft-room' : '/rookie-draft-room'))
      assert.equal((await rooms()).find((draft) => draft.id === room.id)?.status, 'in_progress')
      await press(button('Stop draft'))
      await press(button('Stop Draft'))
      await page.waitForURL((url) => url.pathname === '/league')
      await open('/league?tab=mockRooms')
      await press(button(`Delete ${name}`))
      await wait(async () => !(await rooms()).some((draft) => draft.id === room.id))
      assert.equal((await members(room.id)).length, 0)
      completed.push({ kind, scheduled, joined: true, left: true, started: true, stopped: true, deleted: true })
    }
    assert.deepEqual(await db(fixture.admin.from('roster_players').select('id').eq('league_id', fixture.league.id).order('id')), initialRoster)
    return { leagueId: fixture.league.id, rooms: completed, realRosterUnchanged: true }
  })
}

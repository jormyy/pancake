import assert from 'node:assert/strict'
import { sql, query, quote, clock, restoreClock, fixture, cleanup, record } from '../../scripts/mutation/draft/clock-stack.mjs'

const base = Date.parse('2025-10-30T12:00:00Z')
const hour = 3600000
const at = milliseconds => new Date(base + milliseconds).toISOString()
const fixtures = []
const exists = id => sql(`SELECT EXISTS(SELECT 1 FROM drafts WHERE id=${quote(id)})`) === 't'
const expire = () => Number(sql('SELECT public.expire_mock_draft_rooms()'))
const deadline = id => Number(sql(`SELECT extract(epoch FROM timer_expires_at)*1000 FROM snake_draft_picks WHERE draft_id=${quote(id)} AND player_id IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1`))
let installed = false

try {
  const cron = query("SELECT json_build_object('jobname',jobname,'schedule',schedule,'command',command,'active',active,'timezone',current_setting('cron.timezone',true)) FROM cron.job WHERE jobname='mock-room-expiry'")
  assert.equal(cron.schedule, '30 9 * * *')
  assert.equal(cron.command, 'SELECT public.expire_mock_draft_rooms()')
  record('cleanup-cron', cron)
  clock(at(0), true)
  installed = true
  const f = await fixture()
  fixtures.push(f)
  const mockIds = []
  function room(timer = 604800, type = 'snake', scheduled = at(0)) {
    const id = query(`SELECT row_to_json(d) FROM create_mock_draft_room_atomic(${quote(f.league)},${quote(f.members[0])},${quote(f.users[0].id)},p_draft_type=>${quote(type)},p_scheduled_at=>${quote(scheduled)},p_rounds=>2,p_pick_timer_seconds=>${timer},p_budget_per_team=>200,p_timer_expiry_behavior=>'pause_draft') d`).id
    mockIds.push(id)
    return id
  }
  function start(id) {
    sql(`SELECT join_mock_draft_room_atomic(${quote(id)},${quote(f.members[1])},${quote(f.users[1].id)}); SELECT start_mock_draft_room_atomic(${quote(id)},${quote(f.members[0])},${quote(f.users[0].id)})`)
  }
  function pick(id) {
    const member = sql(`SELECT member_id FROM snake_draft_picks WHERE draft_id=${quote(id)} AND player_id IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1`)
    const count = Number(sql(`SELECT count(*) FROM snake_draft_picks WHERE draft_id=${quote(id)} AND player_id IS NOT NULL`))
    sql(`SELECT make_snake_pick_atomic(${quote(id)},${quote(member)},${quote(f.players[count])})`)
  }
  const long = room()
  start(long)
  clock(at(hour))
  pick(long)
  const due = deadline(long)
  clock(at(25 * hour))
  assert(due > base + 25 * hour, 'The current pick still has time remaining')
  record('long-room-before-cleanup', query(`SELECT json_build_object('provenance','SYNTHETIC','draft',id,'isMock',is_mock,'status',status,'timerSeconds',pick_timer_seconds,'startedAt',started_at,'observedAt',clock_timestamp(),'deadline',to_timestamp(${due}/1000.0),'remainingSeconds',(${due}/1000.0)-extract(epoch FROM clock_timestamp()),'madePicks',(SELECT count(*) FROM snake_draft_picks WHERE draft_id=${quote(long)} AND player_id IS NOT NULL)) FROM drafts WHERE id=${quote(long)}`))
  const removed = expire()
  record('long-room-after-cleanup', { draft: long, removed, exists: exists(long) })
  assert(exists(long), 'A seven-day mock room must survive cleanup at started_at + 25 hours while its next pick is on the clock')
  assert.equal(deadline(long), due)
  for (let i = 0; i < 3; i++) pick(long)
  assert.equal(sql(`SELECT status FROM drafts WHERE id=${quote(long)}`), 'completed')
  assert.equal(Number(sql(`SELECT count(DISTINCT player_id) FROM snake_draft_picks WHERE draft_id=${quote(long)}`)), 4)
  record('long-room-survives', { provenance: 'SYNTHETIC', draft: long, startedAt: at(0), observedAt: at(25 * hour), deadline: new Date(due).toISOString(), removed, completed: true })

  clock(at(0))
  const abandoned = room()
  start(abandoned)
  clock(at(hour))
  pick(abandoned)
  const abandonedDue = deadline(abandoned)
  clock(new Date(abandonedDue + 24 * hour).toISOString())
  expire()
  assert(exists(abandoned), 'An abandoned room remains at the exact deadline plus 24-hour boundary')
  clock(new Date(abandonedDue + 24 * hour + 1000).toISOString())
  expire()
  assert(!exists(abandoned), 'An abandoned seven-day room expires after its deadline plus 24 hours')

  clock(at(0))
  const paused = room()
  start(paused)
  clock(at(hour))
  pick(paused)
  clock(at(2 * hour))
  sql(`SELECT pause_draft_atomic(${quote(paused)})`)
  const saved = query(`SELECT json_build_object('remaining',timer_paused_remaining_seconds,'pausedAt',paused_at) FROM drafts WHERE id=${quote(paused)}`)
  assert.equal(saved.remaining, 604800 - 3600)
  clock(at(25 * hour))
  expire()
  assert(exists(paused), 'A paused long room retains its saved remaining time for cleanup')
  const pausedDue = Date.parse(saved.pausedAt) + saved.remaining * 1000
  clock(new Date(pausedDue + 24 * hour).toISOString())
  expire()
  assert(exists(paused), 'A paused room remains at its fixed retention boundary')
  clock(new Date(pausedDue + 24 * hour + 1000).toISOString())
  expire()
  assert(!exists(paused), 'Pausing cannot keep an abandoned room forever')

  clock(at(0))
  const short = room(60)
  start(short)
  pick(short)
  clock(at(25 * hour))
  expire()
  assert(!exists(short), 'An abandoned short-timer room still expires')

  clock(at(0))
  const noTimer = room(60)
  start(noTimer)
  clock(at(59000))
  pick(noTimer)
  clock(at(120000))
  sql(`SELECT * FROM process_expired_snake_pick_atomic(${quote(noTimer)})`)
  assert.equal(sql(`SELECT status::text || ':' || (timer_paused_remaining_seconds IS NULL)::text FROM drafts WHERE id=${quote(noTimer)}`), 'paused:true')
  clock(at(24 * hour + 30000))
  expire()
  assert(exists(noTimer), 'Without a timer, cleanup measures idle time from the last pick')
  clock(at(24 * hour + 60000))
  expire()
  assert(!exists(noTimer), 'A timer-expiry pause without remaining time still expires')

  clock(at(0))
  const auction = room(30, 'auction')
  start(auction)
  clock(at(25 * hour - 1000))
  const nominator = sql(`SELECT member_id FROM draft_orders WHERE draft_id=${quote(auction)} AND position=1`)
  const user = f.users[f.members.indexOf(nominator)].id
  sql(`UPDATE players SET years_exp=5 WHERE id=${quote(f.players[11])}; SELECT create_auction_nomination_atomic(${quote(auction)},${quote(nominator)},${quote(f.players[11])},${quote(user)})`)
  clock(at(25 * hour))
  expire()
  assert(exists(auction), 'An auction nomination on the clock also retains its room')
  sql(`SELECT pause_draft_atomic(${quote(auction)})`)
  assert.equal(Number(sql(`SELECT timer_paused_remaining_seconds FROM drafts WHERE id=${quote(auction)}`)), 29)
  clock(at(49 * hour + 30000))
  expire()
  assert(!exists(auction), 'An abandoned paused auction still expires')

  for (const type of ['snake', 'auction']) {
    clock(at(0))
    const pending = room(type === 'snake' ? 60 : 30, type, at(10 * hour))
    const cancelled = room(type === 'snake' ? 60 : 30, type)
    start(cancelled)
    clock(at(hour))
    sql(`SELECT stop_draft_atomic(${quote(cancelled)})`)
    clock(at(25 * hour))
    expire()
    assert(exists(cancelled), 'Cancelled retention still uses completed_at and a strict boundary')
    assert(exists(pending), 'Pending retention still uses scheduled_at')
    clock(at(25 * hour + 1000))
    expire()
    assert(!exists(cancelled))
    assert(exists(pending))
    clock(at(34 * hour))
    expire()
    assert(exists(pending), 'Pending rooms remain at their original boundary')
    clock(at(34 * hour + 1000))
    expire()
    assert(!exists(pending))
  }

  clock(at(0))
  const completed = room()
  start(completed)
  clock(at(hour))
  for (let i = 0; i < 4; i++) pick(completed)
  clock(at(25 * hour))
  expire()
  assert(exists(completed), 'Completed retention still uses completed_at and a strict boundary')
  clock(at(25 * hour + 1000))
  expire()
  assert(!exists(completed))

  clock(at(0))
  const real = query(`SELECT start_rookie_draft_atomic(${quote(f.league)},2,false,604800,'pause_draft')`).id
  pick(real)
  clock(at(30 * 24 * hour))
  expire()
  assert(exists(real), 'Cleanup never deletes a real draft with the same ages')
  assert.equal(Number(sql(`SELECT count(*) FROM notification_outbox WHERE data->>'draftId' IN (${mockIds.map(quote).join(',')})`)), 0)
  record('mock-expiry-complete', { passed: true, provenance: 'SYNTHETIC', longTimerSeconds: 604800, pausedRemaining: saved.remaining, boundary: 'strictly more than 24 hours', noTimerLastPick: true, shortAbandoned: true, pendingCancelledCompletedUnchanged: true, realDraftRetained: true })
} finally {
  try {
    cleanup(fixtures)
  } finally {
    if (installed) restoreClock()
  }
}

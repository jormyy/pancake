import { liveFixture, must, quote, report, sql } from './worker-harness.mjs'

const WORKER_BUDGET = "SET statement_timeout='3s'; SET lock_timeout='250ms';"
const SMALL_BACKLOG = 3000
const LARGE_BACKLOG = 300000
const MAX_GROWTH = 10
const TIMER_FLOOR_MS = 20

const cases = [
  {
    name: 'claim_notification_outbox_atomic',
    unit: 'pending notifications',
    setup() {
      const fixture = liveFixture()
      let seeded = 0
      return {
        seed(rows) {
          must(`INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,available_at)
            SELECT ${quote(`budget:${fixture.tag}:`)}||n,${quote(fixture.members[0])},'trade_completed','Budget fixture','Fixture','{}','trade',now()-interval '1 hour'
            FROM generate_series(${seeded + 1},${rows}) n; ANALYZE public.notification_outbox`)
          seeded = rows
        },
        cleanup() {
          sql(`DELETE FROM public.notification_outbox WHERE dedupe_key LIKE ${quote(`budget:${fixture.tag}:%`)}`)
          fixture.cleanup()
        },
      }
    },
    run: 'SET ROLE service_role; SELECT count(*) FROM public.claim_notification_outbox_atomic(100,60)',
    expect: (out) => Number(out) > 0,
    fix: 'bound the candidate set with LIMIT before calling per-row checks such as private.notif_is_stale, then classify only that batch.',
    history: '35edab57 fixed this after the release 2.1 production timeout',
  },
]

const timed = (entry) => {
  const result = sql(`${WORKER_BUDGET}\n${entry.run}`, { timeout: 30000 })
  const out = result.out.split('\n').at(-1)
  if (!result.ok) throw new Error(`${result.err.split('\n')[0]} after ${Math.round(result.ms)} ms`)
  if (!entry.expect(out)) throw new Error(`returned ${out}, so it did no work and the budget is unmeasured`)
  return result.ms
}

const results = []
for (const entry of cases) {
  let fixture
  try {
    fixture = entry.setup()
    fixture.seed(SMALL_BACKLOG)
    const small = timed(entry)
    fixture.seed(LARGE_BACKLOG)
    const large = timed(entry)
    const growth = large / Math.max(small, TIMER_FLOOR_MS)
    results.push({
      name: `${entry.name} over ${LARGE_BACKLOG} ${entry.unit}`,
      ok: growth <= MAX_GROWTH,
      detail: `${Math.round(small)} ms at ${SMALL_BACKLOG}, ${Math.round(large)} ms at ${LARGE_BACKLOG}: ${growth.toFixed(1)}x growth${growth > MAX_GROWTH ? `, over the ${MAX_GROWTH}x bound for one batch` : ''}`,
      fix: entry.fix,
      history: entry.history,
    })
  } catch (error) {
    results.push({ name: `${entry.name} over ${LARGE_BACKLOG} ${entry.unit}`, ok: false, detail: error.message.split('\n')[0], fix: entry.fix, history: entry.history })
  } finally {
    fixture?.cleanup()
  }
}
process.exit(report(results))

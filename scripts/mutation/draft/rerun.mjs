// Turn-10 draft reruns: cutoff-equality on the current opening-night cutoff definition (superseded 201 -> 206),
// plus a deployed-definition scan of every other recorded draft-timer target.
// Usage on an owned local stack: node scripts/mutation/draft/rerun.mjs <checkout sha> [mutations|scan]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ownedStack, rerunMutants, scanTargets } from '../identity/t10-rerun.mjs'

const [baseSha, mode = 'mutations'] = process.argv.slice(2)
const evidence = resolve(process.env.T10_EVIDENCE ?? 'evidence/t10/draft')
const stack = ownedStack()
const start = 'public.start_rookie_draft_atomic(uuid,integer,boolean,integer,text)'
const cutoff = 'private.draft_timer_complete_opening_night(integer,timestamp with time zone)'
const pause = 'public.pause_draft_atomic(uuid,uuid)'
const warning = 'public.draft_timer_start_warning(uuid,integer,integer)'
const expiry = 'public.expire_mock_draft_rooms()'
if (mode === 'scan') {
  mkdirSync(evidence, { recursive: true })
  const scan = scanTargets(stack, [
    { id: 'timer-min', symbol: start, file: 'supabase/migrations/20261020000202_draft_arm_after_lock.sql', original: 'p_pick_timer_seconds < 60' },
    { id: 'timer-max', symbol: start, file: 'supabase/migrations/20261020000202_draft_arm_after_lock.sql', original: 'p_pick_timer_seconds > 604800' },
    { id: 'cutoff-equality', symbol: cutoff, file: 'supabase/migrations/20261020000201_draft_cutoff_atomic_results.sql', original: '<= p_at' },
    { id: 'pause-rounding', symbol: pause, file: 'supabase/migrations/20261020000200_rookie_draft_long_timers.sql', original: 'CEIL(EXTRACT(EPOCH FROM (timer_expires_at - v_now)))::int' },
    { id: 'warning-multiply', symbol: warning, file: 'supabase/migrations/20261020000200_rookie_draft_long_timers.sql', original: 'v_picks::double precision * p_pick_timer_seconds' },
    { id: 'warning-comparison', symbol: warning, file: 'supabase/migrations/20261020000200_rookie_draft_long_timers.sql', original: 'v_finish >= v_cutoff' },
    { id: 'mock-max', symbol: 'public.create_mock_draft_room_atomic(uuid,uuid,uuid,text,text,timestamp with time zone,text,integer,integer,integer,text)', file: 'supabase/migrations/20261020000204_mock_rookie_timer_range.sql', original: 'v_timer_seconds > 604800' },
    { id: 'restart-pause-second', symbol: pause, file: 'supabase/migrations/20261020000200_rookie_draft_long_timers.sql', original: 'CEIL(EXTRACT(EPOCH FROM (timer_expires_at - v_now)))::int' },
    { id: 'restart-resume-full', symbol: 'public.resume_draft_atomic(uuid,uuid)', file: 'supabase/migrations/20261020000200_rookie_draft_long_timers.sql', original: 'COALESCE(v_draft.timer_paused_remaining_seconds,' },
    { id: 'cutoff-exact-second', symbol: cutoff, file: 'supabase/migrations/20261020000206_complete_skipped_rookie_picks_at_opening.sql', original: '<= p_at' },
    { id: 'cutoff-skipped-recovery', symbol: cutoff, file: 'supabase/migrations/20261020000206_complete_skipped_rookie_picks_at_opening.sql', original: 'SET skipped_at=NULL, skip_reason=NULL' },
    { id: 'mock-expiry-start-anchor', symbol: expiry, file: 'supabase/migrations/20261020000260_mock_room_deadline_retention.sql', original: 'SELECT pick.timer_expires_at' },
    { id: 'mock-expiry-paused-subtraction', symbol: expiry, file: 'supabase/migrations/20261020000260_mock_room_deadline_retention.sql', original: '+ make_interval(secs => draft.timer_paused_remaining_seconds)' },
    { id: 'mock-expiry-inclusive-boundary', symbol: expiry, file: 'supabase/migrations/20261020000260_mock_room_deadline_retention.sql', original: 'draft.created_at\n         ) < now()' },
  ])
  writeFileSync(join(evidence, 'target-scan.json'), JSON.stringify({ baseSha, scan }, null, 2) + '\n')
  console.log(JSON.stringify(scan))
} else {
  const oracles = {
    behavior: { name: 'tests/db/draft-timer-behavior.sql', kind: 'db-deployed', command: ['node', 'scripts/mutation/draft/check.mjs', 'tests/db/draft-timer-behavior.sql'] },
  }
  const rows = rerunMutants({ lane: 'claude-gaps', evidence, baseSha, stack, oracles, mutants: [
    { id: 'cutoff-equality', area: 'draft-timer', symbol: cutoff, operator: 'relational <= -> <', oracle: 'behavior',
      priorSha: '454cf583dbdf70c124100148939cd36c09b76e4e', priorOutcome: 'killed', original: '<= p_at', mutated: '< p_at',
      notes: 'Prior verdict targeted migration 20261020000201; the current definition is 20261020000206. Same operator, original text and killing oracle.' },
  ] })
  if (rows.some(row => row.outcome === 'survived')) process.exitCode = 1
}

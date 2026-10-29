import assert from 'node:assert/strict'

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function detachedReplayCommand(runId, profile = 'full') {
  assert.match(runId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.ok(['full', 'control'].includes(profile), 'Unknown capture profile')
  const directory = `../runs/${runId}`
  const runner = `node scripts/perf-lab/mini.mjs replay; result=$?; printf '%s\\n' "$result" > ${shellQuote(directory + '/exit-code')}; exit "$result"`
  return `mkdir -p ${shellQuote(directory)} && (PERF_LAB_RUN_ID=${runId} PERF_LAB_CAPTURE_PROFILE=${profile} PERF_LAB_SECONDS=0 nohup sh -c ${shellQuote(runner)} > ${shellQuote(directory + '/replay.log')} 2>&1 < /dev/null & replay_pid=$!; printf '%s\\n' "$replay_pid" > ${shellQuote(directory + '/pid')}; printf '%s\\n' "$replay_pid")`
}

export function detachedReceipt(runId, output, source, profile = 'full') {
  detachedReplayCommand(runId, profile)
  const pid = Number(output.trim())
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'The detached replay did not return a PID')
  const root = `~/pancake-t_4ba51e0d/lanes/fable-timeline/perf-lab/runs/${runId}`
  return { runId, source, pid, log: `${root}/replay.log`, pidFile: `${root}/pid`, exitFile: `${root}/exit-code`, profile, seconds: 0 }
}

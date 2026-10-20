import { summarize } from './profile.ts'

type Summary = { median: number; p95: number; min: number; max: number; count: number }
type Statement = { query: string; calls: number; rows: number; total_exec_time: number; mean_exec_time: number; shared_blks_hit: number; shared_blks_read: number; toplevel: boolean; role?: string }
type Sample = { requests?: {localRequests:number;peakFetches:number}; ms: number; dbMs: number; tableRowsRead: number; tableRowsWritten: number; error?: string; result?: { status?: number; bytes?: number; rows?: number; data?: unknown } }
type Measurement = { name: string; kind: string; latencyMs: Summary; dbMs: Summary; rowsRead: Summary; rowsWritten: Summary; samples: Sample[]; snapshot: { statements: Statement[] } }
type Report = { label: string; generatedAt: string; command: string; counts: Record<string,number>; method: Record<string,unknown>; activeJobMethod?:string; cron: { jobname: string; schedule: string; command: string }[]; measurements: Measurement[] }

const [input, destination] = Deno.args
if (!input || !destination) throw Error('Use profile-report.ts INPUT.json OUTPUT.md')
const report: Report = JSON.parse(await Deno.readTextFile(input))
const n = (value: number | undefined) => value === undefined ? 'unknown' : value.toFixed(2)
const rows = (items: string[][]) => items.map(row => '| '+row.join(' | ')+' |').join('\n')
const content = [`# ${report.label} workload measurements`, '', `Captured ${report.generatedAt}.`, '', '## Command', '', '```sh', report.command, '```', '',
  '## Dataset', '', ...Object.entries(report.counts).map(([table,count]) => `- ${table}: ${count.toLocaleString()}`), '',
  '## Method', '', ...Object.entries(report.method).map(([key,value]) => `- ${key}: ${value}`), '',
  report.activeJobMethod ?? '', '', '## Reads and jobs', '', 'Times use milliseconds. Bytes count uncompressed response bodies. Rows read are asynchronous PostgreSQL tuple counters.',
  'Failures remain visible. Empty or failed jobs do not prove active-season cost. These figures include local transport, not hosted latency.', '',
  '| Workload | Kind | Median | p95 | Range | DB median | Bytes median | Response rows | Read tuples median | Written tuples median | Local requests median | Peak fetches | Failures |',
  '|---|---|---:|---:|---|---:|---:|---|---:|---:|---:|---:|---:|',
  rows(report.measurements.map(m => [m.name,m.kind,n(m.latencyMs.median),n(m.latencyMs.p95),`${n(m.latencyMs.min)}–${n(m.latencyMs.max)}`,n(m.dbMs.median),
    n(summarize(m.samples.flatMap(s => s.result?.bytes === undefined ? [] : [s.result.bytes]))?.median),
    [...new Set(m.samples.map(s => s.result?.rows ?? 'unknown'))].join(','), n(m.rowsRead.median),n(m.rowsWritten.median),
    n(summarize(m.samples.flatMap(s => s.requests ? [s.requests.localRequests] : []))?.median),
    m.samples.some(s => s.requests) ? String(Math.max(...m.samples.map(s => s.requests?.peakFetches ?? 0))) : 'unknown',
    String(m.samples.filter(s => s.error || (s.result?.status ?? 200) >= 400).length)])), '',
  '## Cron dispatch schedules', '', '| Job | Schedule | Command |','|---|---|---|', rows(report.cron.map(c => [c.jobname,c.schedule,c.command.replaceAll('|','\\|')])), '',
  'Dispatch schedules show predicate checks. Time gates, leases, batches, and retries change actual worker invocations.',
  'The measured harness runs jobs in sequence. Its peak is one worker. Production overlap remains unmeasured.', '',
  '## Failures and job responses','']
for (const m of report.measurements) {
  const errors = m.samples.filter(s => s.error || (s.result?.status ?? 200)>=400)
  if (errors.length || m.kind !== 'read') content.push(`### ${m.name}`, '', '```json', JSON.stringify(m.samples.slice(0,1).map(s => ({ error: s.error,result: s.result })),null,2), '```','')
}
const combined = new Map<string,Statement>()
for (const m of report.measurements) for (const s of m.snapshot.statements) {
  const key = `${s.role}:${s.toplevel}:${s.query}`
  const previous = combined.get(key)
  if (previous) {
    for (const field of ['calls','rows','total_exec_time','shared_blks_hit','shared_blks_read'] as const) previous[field]+=Number(s[field])
    previous.mean_exec_time=previous.total_exec_time/previous.calls
  } else combined.set(key,{...s})
}
const statements = [...combined.values()]
await Deno.writeTextFile(destination.replace(/\.md$/, '')+'-top-statements.json', JSON.stringify({ total: [...statements].sort((a,b) => b.total_exec_time-a.total_exec_time).slice(0,30),
  mean: [...statements].sort((a,b) => b.mean_exec_time-a.mean_exec_time).slice(0,30) }, null,2)+'\n')
for (const [name, list] of [['Total time', [...statements].sort((a,b) => b.total_exec_time-a.total_exec_time)],['Mean time',[...statements].sort((a,b) => b.mean_exec_time-a.mean_exec_time)]] as const) {
  content.push(`## Top 30 statements: ${name}`, '', 'Nested statements overlap parent times. Do not add them together.', '',
    '| Rank | Total ms | Mean ms | Calls | Rows | Blocks hit/read | Top level | Query excerpt |','|---:|---:|---:|---:|---:|---|---|---|',
    rows(list.slice(0,30).map((s,index) => [String(index+1),n(s.total_exec_time),n(s.mean_exec_time),String(s.calls),String(s.rows),`${s.shared_blks_hit}/${s.shared_blks_read}`,String(s.toplevel),s.query.replaceAll(/\s+/g,' ').replaceAll('|','\\|').slice(0,240)])), '')
}
await Deno.writeTextFile(destination,content.join('\n')+'\n')
console.log(`Wrote ${destination}`)

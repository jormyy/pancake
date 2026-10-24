import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const url = process.env.SUPABASE_DB_URL
if (!url) throw new Error('SUPABASE_DB_URL is required')
const target = new URL(url)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.port === '54322') {
  throw new Error('Use an isolated local database on a lane port')
}
const sql = (input) => execFileSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const mode = process.argv[2]
if (mode === 'seed') {
  process.stdout.write(sql(readFileSync(new URL('./seed.sql', import.meta.url), 'utf8')))
} else if (mode === 'measure') {
  const output = sql(readFileSync(new URL('./workload.sql', import.meta.url), 'utf8'))
  const file = process.argv[3]
  if (file) writeFileSync(file, output)
  process.stdout.write(output)
} else if (mode === 'realtime') {
  const { createClient } = await import('@supabase/supabase-js')
  const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8' }))
  if (!['127.0.0.1', 'localhost'].includes(new URL(status.API_URL).hostname)) throw new Error('Use local Realtime')
  const client = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const channel = client.channel('load-profile').on('postgres_changes', { event: '*', schema: 'public', table: 'league_change_hints' }, () => {})
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime subscription timed out')), 15000)
      channel.subscribe((state) => {
        if (state === 'SUBSCRIBED') { clearTimeout(timer); resolve() }
        else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(state)) }
      })
    })
    sql('SELECT pg_stat_statements_reset();')
    sql("UPDATE public.league_change_hints SET revision=revision+1,updated_at=clock_timestamp() WHERE league_id::text LIKE 'db100000-%' AND topic='resources';")
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const output = sql("COPY (SELECT calls,round(total_exec_time::numeric,3) total_ms,round(mean_exec_time::numeric,3) mean_ms,rows,query FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' AND (query LIKE '%wal->>%' OR query LIKE '%list_changes%') ORDER BY total_exec_time DESC) TO STDOUT WITH CSV HEADER;")
    if (process.argv[3]) writeFileSync(process.argv[3], output)
    process.stdout.write(output)
  } finally {
    await client.removeChannel(channel)
    client.realtime.disconnect()
  }
} else {
  throw new Error('Use seed, measure [report.csv], or realtime [report.csv]')
}

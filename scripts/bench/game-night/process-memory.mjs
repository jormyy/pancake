import { command, loopback } from './common.mjs'

export async function processMemory(stack) {
  const processes = JSON.parse(await stack.sql("SELECT coalesce(json_agg(p),'[]') FROM (SELECT pid,application_name,usename,backend_type,state,left(query,200) query FROM pg_stat_activity)p"))
  const pids = processes.map(row => String(row.pid)).filter(pid => /^\d+$/.test(pid))
  const output = (await command('docker', ['exec', '--user', 'postgres', stack.container, 'sh', '-c', 'for pid do printf "PID %s\\n" "$pid"; cat /proc/$pid/smaps_rollup 2>/dev/null || true; done', 'game-night-memory', ...pids])).stdout
  const memory = new Map(output.split(/^PID /m).slice(1).map(part => {
    const [pid, ...lines] = part.split('\n')
    const fields = Object.fromEntries(lines.flatMap(line => {
      const match = /^(Rss|Pss|Private_Clean|Private_Dirty|Anonymous|Swap|SwapPss):\s+(\d+) kB$/.exec(line)
      return match ? [[match[1], Number(match[2]) * 1024]] : []
    }))
    return [Number(pid), fields]
  }))
  return { at: Date.now(), processes: processes.map(row => ({ ...row, memory: memory.get(row.pid) ?? null })) }
}

export async function memoryContexts(stack, samples = 10) {
  const url = loopback(`${stack.api}/rest/v1/rpc/game_night_memory_contexts`, [stack.ports.api])
  const rows = await Promise.all(Array.from({ length: samples }, async () => {
    const response = await fetch(url, { method: 'POST', headers: { apikey: stack.keys.SERVICE_ROLE_KEY, authorization: `Bearer ${stack.keys.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Memory context sample returned ${response.status}`)
    return response.json()
  }))
  return { at: Date.now(), rows: [...new Map(rows.map(row => [row.pid, row])).values()] }
}

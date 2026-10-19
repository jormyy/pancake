const api = Deno.env.get('SUPABASE_URL')!
if (!['127.0.0.1','localhost'].includes(new URL(api).hostname)) throw new Error('Local database required')
const { runLivePoll } = await import('../../functions/live-poll/runner.ts')
const response = await runLivePoll(new Request('http://localhost/live-poll', { method: 'POST' }))
console.log(JSON.stringify({ status: response.status, result: await response.json() }))

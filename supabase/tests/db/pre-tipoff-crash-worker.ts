const api = Deno.env.get('SUPABASE_URL')!
if (!['127.0.0.1', 'localhost'].includes(new URL(api).hostname)) throw new Error('Local database required')
const { processPreTipoff } = await import('../../functions/lineup-optimizer/preTipoff.ts')
console.log(JSON.stringify(await processPreTipoff({ tipoffAt: Deno.args[0], token: Deno.args[1] })))

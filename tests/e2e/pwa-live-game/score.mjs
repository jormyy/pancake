const { syncScores } = await import(new URL('../../../supabase/functions/_shared/syncScores.ts', import.meta.url).href)
await syncScores(globalThis['Deno'].args[0], new Date(), { recoverStats: false })

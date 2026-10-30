const serve=globalThis.Deno.serve
globalThis.Deno.serve=handler=>serve({hostname:'127.0.0.1',port:64238,onListen(){}},handler)
await import('../../supabase/functions/refresh-views/index.ts')

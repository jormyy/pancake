import { gzipSync } from 'node:zlib'
import { createLiveHandler } from '../../../server/live/handler.ts'

const today = new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})
const date = new Date(Date.parse(`${today}T12:00:00Z`)-86400000).toISOString().slice(0,10)
const started = performance.now()
const response = await createLiveHandler()(new Request(`http://local/api/live/${date}`))
const body = await response.text()
const value = JSON.parse(body)
const report = { at: new Date().toISOString(), date, status: response.status, milliseconds: performance.now()-started,
  bytes: new TextEncoder().encode(body).length, gzipBytes: gzipSync(body).byteLength,
  games: value.games?.length ?? 0, sources: [...new Set(value.games?.map((game: { source: string }) => game.source) ?? [])],
  error: value.error ?? null, limitation: 'This verifies the Mac source path. Vercel source access needs a later authorized deployment check.' }
await Deno.writeTextFile(Deno.args[0],JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report))

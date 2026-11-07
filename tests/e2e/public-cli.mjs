import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const execute=promisify(execFile)
export async function verifyLive(apiUrl,league,{live=false}={}) {
const base=new URL(apiUrl)
assert.ok((base.protocol==='http:'&&['localhost','127.0.0.1'].includes(base.hostname)) || (live&&base.protocol==='https:'))
assert.match(league??'',/^[a-f0-9-]{36}$/i)
const run=async(name,options=[])=>{
  const result=await execute(process.execPath,['packages/pancake-cli/bin/pancake.mjs',name,'--json','--no-cache','--api-url',base.href,...(name==='leagues'?[]:['--league',league]),...options])
  assert.equal(result.stderr,'')
  const page=JSON.parse(result.stdout)
  assert.equal(page.version,2)
  assert.equal(page.resource,name)
  return page
}
const description=JSON.parse((await execute(process.execPath,['packages/pancake-cli/bin/pancake.mjs','describe'])).stdout)
const teams=await run('teams')
assert.ok(teams.items.length,'Seed at least one public team for the roster check')
for(const name of Object.keys(description.schemas)) await run(name,name==='rosters'?['--team',teams.items[0].id]:[])
return {resources:Object.keys(description.schemas).length,authenticated:false}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await verifyLive(process.env.PANCAKE_API_URL,process.env.PANCAKE_LEAGUE_ID,{live:process.argv.includes('--live')})))

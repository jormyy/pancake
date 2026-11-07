import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execute=promisify(execFile)
export async function verifyInstalled() {
  const temporary=await mkdtemp(path.join(tmpdir(),'pancake-installed-'))
  const fixture=JSON.parse(await readFile('tests/fixtures/public-cli/league-v2.json','utf8'))
  const observed=[]
  const server=createServer((req,res)=>{
    observed.push(req.url)
    assert.equal(req.headers.authorization,undefined)
    assert.equal(req.headers.apikey,undefined)
    const url=new URL(req.url,'http://localhost')
    const name=url.pathname.split('/').at(-1)
    if(url.searchParams.get('league')==='00000000-0000-4000-8000-000000000000'){
      res.writeHead(404,{'Content-Type':'application/json'});res.end('{}');return
    }
    res.writeHead(200,{'Content-Type':'application/json','ETag':'"stub"'})
    res.end(JSON.stringify(fixture.resources[name]))
  })
  await new Promise(resolve=>server.listen({port:0,host:'127.0.0.1'},()=>resolve(undefined)))
  try {
    const packed=await execute('npm',['pack','./packages/pancake-cli','--pack-destination',temporary,'--json'])
    const archive=path.join(temporary,JSON.parse(packed.stdout)[0].filename)
    await execute('npm',['install','--global','--prefix',path.join(temporary,'installed'),archive,'--ignore-scripts','--no-audit','--no-fund'])
    const bin=path.join(temporary,'installed','bin','pancake')
    const address=server.address()
    assert.ok(address && typeof address!=='string')
    const base=`http://127.0.0.1:${address.port}`
    const league='11111111-1111-4111-8111-111111111111'
    for(const name of Object.keys(fixture.resources)){
      const args=[name,'--json','--no-cache','--api-url',base,...(name==='leagues'?[]:['--league',league]),...(name==='rosters'?['--team',league]:[])]
      const result=await execute(bin,args)
      assert.equal(result.stderr,'')
      assert.deepEqual(JSON.parse(result.stdout),fixture.resources[name])
      assert.equal(JSON.parse(result.stdout).items.length,1)
    }
    assert.equal(JSON.parse((await execute(bin,['describe'])).stdout).version,2)
    assert.equal(JSON.parse((await execute(bin,['explain','trades.completedAt'])).stdout).version,2)
    await assert.rejects(execute(bin,['db-health']),{code:2,stdout:''})
    await assert.rejects(execute(bin,['teams','--league','bad']),{code:4,stdout:''})
    await assert.rejects(execute(bin,['teams','--league','00000000-0000-4000-8000-000000000000','--api-url',base]),{code:4,stdout:''})
    assert.equal(observed.length,Object.keys(fixture.resources).length+1)
  } finally { await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true}) }
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) { await verifyInstalled(); console.log("Installed public CLI: all commands passed") }

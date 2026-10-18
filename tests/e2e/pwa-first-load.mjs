import {createRequire} from 'node:module'
import {createServer,request as httpRequest} from 'node:http'
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {brotliDecompressSync,gunzipSync} from 'node:zlib'
import {performance} from 'node:perf_hooks'
const require=createRequire(new URL('../../package.json',import.meta.url)),{chromium,webkit,devices}=require('playwright'),root=process.env.TASK_DIR,dir=root+'/evidence/stage2/lane-b/'+(process.env.PWA_MEASUREMENT_NAME??'first-load')
await mkdir(dir,{recursive:true})
let build='before',epoch=0,poison=null
const requests=[],port=56852,origin='http://127.0.0.1:'+port
const probe='<!doctype html><html><head><title>Public worker probe</title></head><body>Public worker probe</body></html>'
const server=createServer((req,res)=>{
 const currentEpoch=epoch,currentBuild=build,currentPoison=poison,path=new URL(req.url,origin).pathname
 if(path==='/_probe'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(probe);return}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
 const forward=httpRequest({hostname:'127.0.0.1',port:currentBuild==='before'?56850:56851,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1'}},incoming=>{
  const parts=[];incoming.on('data',part=>parts.push(part));incoming.on('end',()=>{
   let body=Buffer.concat(parts),headers={...incoming.headers};delete headers['transfer-encoding'];delete headers.connection
   if(path===currentPoison){body=Buffer.from('untrusted cached build bytes');delete headers['content-encoding'];headers['content-type']='text/javascript';headers['cache-control']='public, max-age=31536000, immutable'}
   headers['content-length']=String(body.length)
   res.on('finish',()=>requests.push({epoch:currentEpoch,build:currentBuild,path,status:incoming.statusCode,bodyBytes:body.length,decodedBytes:headers['content-encoding']==='br'?brotliDecompressSync(body).length:headers['content-encoding']==='gzip'?gunzipSync(body).length:body.length,responseHeaderBytes:Buffer.byteLength(Reflect.get(res,'_header')??''),encoding:headers['content-encoding']??null,poisoned:path===currentPoison}))
   res.writeHead(incoming.statusCode,headers);res.end(body)
  })
 });forward.on('error',()=>{res.writeHead(502);res.end('Task server unavailable')});forward.end()
})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(undefined))})
const out={method:'Fresh separate browser profiles. A loopback proxy records actual finished HTTP responses, encoded body bytes and serialized HTTP/1.1 response headers. HTTP-cache and service-worker hits that make no server request contribute zero network bytes. Compression labels come from forwarded response headers. No production request or sign-in occurs.',builds:JSON.parse(process.env.PWA_BUILD_LABELS??'{}'),samples:[],integrity:[]}
const guard=context=>context.addInitScript(()=>{const original=window.fetch.bind(window);window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);if(/^\/(auth|rest|functions)\/v1\//.test(url.pathname)&&!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Hosted APIs forbidden in local verification');return original(input,init)}})
const saved=()=>writeFile(dir+'/measurements.json',JSON.stringify(out,null,2))
try{
 for(const engine of ['chromium','webkit'])for(const variant of (process.env.PWA_VARIANTS??'before,candidate').split(','))for(let sample=1;sample<=3;sample++){
  build=variant;poison=null;const profile=dir+'/'+engine+'-'+variant+'-'+sample;await rm(profile,{recursive:true,force:true});const context=await(engine==='chromium'?chromium:webkit).launchPersistentContext(profile,{headless:true,...(engine==='webkit'?devices['iPhone 13']:{viewport:{width:1280,height:900}})}),browser={close:()=>context.close()};await guard(context)
  if(engine==='webkit')await context.addInitScript(()=>Object.defineProperty(navigator,'standalone',{configurable:true,get:()=>true}))
  const page=await context.newPage(),result={engine,variant,sample,segments:[],errors:[]};page.on('pageerror',error=>result.errors.push(String(error)));out.samples.push(result)
  try{
   for(const mode of ['cold','warm']){
    const tag=++epoch,at=performance.now();await page.goto(origin,{waitUntil:'load'});await page.getByRole('textbox',{name:'Email',exact:true}).waitFor({timeout:45000});await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}))});const readyMs=performance.now()-at;await page.waitForTimeout(2500)
    const rows=requests.filter(row=>row.epoch===tag),counts={};for(const row of rows)counts[row.path]=(counts[row.path]??0)+1
    result.segments.push({mode,readyMs,paint:await page.evaluate(()=>({fcp:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null,shell:performance.getEntriesByName('pancake-boot-shell')[0]?.startTime??null,mounted:performance.getEntriesByName('pancake-app-mounted')[0]?.startTime??null})),wallMs:performance.now()-at,requests:rows.length,bodyBytes:rows.reduce((sum,row)=>sum+row.bodyBytes,0),decodedBytes:rows.reduce((sum,row)=>sum+row.decodedBytes,0),responseHeaderBytes:rows.reduce((sum,row)=>sum+row.responseHeaderBytes,0),compression:[...new Set(rows.map(row=>row.encoding).filter(Boolean))],repeatedAssets:Object.entries(counts).filter(([path,count])=>count>1&&!['/','/sw.js'].includes(path)),responses:rows})
   }
   await context.setOffline(true);await page.reload();await page.getByRole('textbox',{name:'Email',exact:true}).waitFor({timeout:15000});result.offlineSignIn=true
  }catch(error){result.error=String(error)}finally{await browser.close();await saved();console.log(engine,variant,sample,result.error??'done')}
 }
 for(const engine of (process.env.PWA_INTEGRITY==='0'?[]:['chromium','webkit']))for(const kind of ['verified','poisoned']){
  build='candidate';poison=null;const script=await readFile(root+'/web-after/sw.js','utf8'),precache=JSON.parse(script.match(/const PRECACHE_URLS = (\[[^\n]*\])/)[1]),asset=precache.find(path=>path.endsWith('.js')),expected=createHash('sha256').update(await readFile(root+'/web-after'+asset)).digest('hex')
  const profile=dir+'/'+engine+'-'+kind;await rm(profile,{recursive:true,force:true});const context=await(engine==='chromium'?chromium:webkit).launchPersistentContext(profile,{headless:true}),browser={close:()=>context.close()};await guard(context);const page=await context.newPage(),result={engine,kind,asset};out.integrity.push(result)
  try{
   await page.goto(origin+'/_probe');poison=kind==='poisoned'?asset:null;await page.evaluate(async url=>{const response=await fetch(url,{credentials:'omit',cache:'reload'});await response.arrayBuffer()},asset);poison=null
   const tag=++epoch;await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});await navigator.serviceWorker.ready});await page.waitForTimeout(500)
   const actual=await page.evaluate(async asset=>{for(const name of await caches.keys()){if(!name.endsWith('-public-v1-assets'))continue;const response=await(await caches.open(name)).match(asset);if(response)return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join('')}return null},asset)
   result.digestMatches=actual===expected;result.assetNetworkRequests=requests.filter(row=>row.epoch===tag&&row.path===asset).length
   if(!result.digestMatches)throw Error('Worker cached bytes do not match the build')
   if(kind==='verified'&&result.assetNetworkRequests!==0)throw Error('Verified boot asset downloaded twice')
   if(kind==='poisoned'&&result.assetNetworkRequests!==1)throw Error('Untrusted HTTP-cache bytes did not trigger a clean fetch')
  }catch(error){result.error=String(error)}finally{await browser.close();await saved();console.log(engine,kind,result.error??'done')}
 }
}finally{await new Promise(resolve=>server.close(resolve));await saved()}
console.log(JSON.stringify({samples:out.samples.length,errors:out.samples.filter(row=>row.error||row.errors.length).length,integrity:out.integrity}))
if(out.samples.some(row=>row.error||row.errors.length)||out.integrity.some(row=>row.error))process.exitCode=1

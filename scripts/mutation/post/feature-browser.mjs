import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runWithScenarioResourceOwner } from '../../../tests/e2e/scenario-resource-owner.mjs'
import { createBrowser, listBrowserSessions, clickButtonByName, fillSignInCredentials, openCdpClient } from '../../../tests/e2e/browser-agent.mjs'

export const runFeatureBrowser = () => runWithScenarioResourceOwner('post playoff fit', runBrowser)

async function runBrowser() {
  const lane=path.join(homedir(),'pancake-t_4ba51e0d/lanes/post')
  assert.equal(process.cwd(),path.join(lane,'repo'))
  const evidence=path.join(lane,'evidence/screenshots');mkdirSync(evidence,{recursive:true})
  const keys=Object.fromEntries(execFileSync('supabase',['status','-o','env'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1).replace(/^"|"$/g,'')]}))
  assert.equal(new URL(keys.API_URL).origin,'http://127.0.0.1:57421')
  assert.equal(new URL(keys.DB_URL).port,'57422');assert.equal(new URL(keys.DB_URL).hostname,'127.0.0.1')
  process.env.E2E_BROWSER_SCREENSHOT_MODE='agent'
  process.env.PATH=path.join(process.cwd(),'node_modules/.bin')+':'+process.env.PATH
  const env={...process.env,EXPO_PUBLIC_SUPABASE_URL:keys.API_URL,EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:keys.ANON_KEY,EXPO_PUBLIC_API_URL:keys.API_URL+'/functions/v1/api'}
  const started=performance.now()
  const build=spawnSync('npx',['expo','export','--clear','--platform','web','--output-dir',path.join(lane,'web-review8')],{env,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024})
  writeFileSync(path.join(lane,'evidence/review8/browser-build.log'),`npx expo export --platform web --output-dir <own lane>/web-review8\n${build.stdout}${build.stderr}\nexit=${build.status} seconds=${((performance.now()-started)/1000).toFixed(2)}\n`)
  assert.equal(build.status,0)
  const files = directory => readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)])
  const sources = files(path.join(lane,'web-review8')).filter(file=>file.endsWith('.js')).map(file=>readFileSync(file,'utf8'))
  assert.ok(sources.some(source=>source.includes('http://127.0.0.1:57421')),'The web build must contain its local API target')
  assert.ok(sources.every(source=>!/https?:\/\/[a-z0-9-]+\.supabase\.co\b/i.test(source)),'The browser must refuse a build with a hosted Supabase target')

  const web=spawn('node',['tests/e2e/static-web-server.mjs','--root',path.join(lane,'web-review8'),'--port','57480'],{env,stdio:['ignore',openSync(path.join(evidence,'server.log'),'a'),openSync(path.join(evidence,'server.log'),'a')]})
  const browser=createBrowser(),session='post-playoff-fit',url='http://127.0.0.1:57480'
  const user=randomUUID(),league=randomUUID(),season=randomUUID(),email=`${user}@example.test`,password=`Local-${randomUUID()}!`
  const sql=statement=>execFileSync('psql',[keys.DB_URL,'-XqAtv','ON_ERROR_STOP=1','-c',statement],{encoding:'utf8'})
  let userCreated=false, fixtureCreated=false
  const api=async(resource,body,token=keys.SERVICE_ROLE_KEY)=>{
    const response=await fetch(keys.API_URL+resource,{method:'POST',headers:{apikey:keys.ANON_KEY,Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})
    const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data
  }
  try {
    await api('/auth/v1/admin/users',{id:user,email,password,email_confirm:true});userCreated=true
    sql(`BEGIN; INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths) VALUES('${league}','Local playoff fit','${league}','${user}','setup',20,4,ARRAY[1,1]); INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',9527,true); INSERT INTO league_members(league_id,user_id,role,team_name) VALUES('${league}','${user}','commissioner','Local team'); INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT 9527,w,date '9526-10-19'+(w-1)*7,date '9526-10-25'+(w-1)*7 FROM generate_series(1,24)w; COMMIT;`);fixtureCreated=true
    const auth=await api('/auth/v1/token?grant_type=password',{email,password},keys.ANON_KEY)
    for(const [start,status] of [[23,'fit'],[24,'does-not-fit']]) {
      const fit=await api('/functions/v1/api/league/playoff-fit',{leagueId:league,start,rounds:[1,1]},auth.access_token)
      assert.deepEqual(fit,{status,lastAvailableWeek:24,requiredWeeks:2,endWeek:Number(start)+1})
    }
    const before=await listBrowserSessions();writeFileSync(path.join(evidence,'sessions-before.txt'),before)
    assert.ok(!before.includes(session),'The isolated session must be unused')
    await browser(session,['set','viewport','393','852'])
    await browser(session,['open',url+'/sign-in'])
    await fillSignInCredentials(browser,session,email,password)
    await clickButtonByName(browser,session,'Sign In')
    let signedIn=false
    for(let attempt=0;attempt<40;attempt++) {
      const result=await browser(session,['eval',`JSON.parse(localStorage.getItem('sb-127-auth-token') || 'null')?.user?.id === ${JSON.stringify(user)}`])
      if(result.trim()==='true') { signedIn=true;break }
      await browser(session,['wait','250'])
    }
    assert.ok(signedIn,'Synthetic commissioner sign-in must settle before navigation')
    await browser(session,['open',url+'/league?tab=settings'])
    let taps=0
    await clickButtonByName(browser,session,'Open commissioner settings');taps++
    let snapshot='',ref
    for(let attempt=0;attempt<40;attempt++) {
      snapshot=await browser(session,['snapshot'])
      ref=snapshot.match(/textbox "Playoff Start Week" \[ref=([^\]]+)\]/)?.[1]
      if(ref) break
      await browser(session,['wait','250'])
    }
    writeFileSync(path.join(evidence,'settings-snapshot.txt'),snapshot)
    assert.ok(ref,'Playoff input must be present')
    await browser(session,['click',ref]);taps++
    await browser(session,['fill',ref,'24'])
    for(let attempt=0;attempt<20;attempt++) {
      snapshot=await browser(session,['snapshot'])
      if(snapshot.includes('Last available: week 24')) break
      await browser(session,['wait','250'])
    }
    assert.ok(snapshot.includes('Last available: week 24'))
    writeFileSync(path.join(evidence,'warning-snapshot.txt'),snapshot)
    const layouts=[]
    for(const [label,width,height,dpr] of [['iphone-pwa',393,852,3],['desktop',1440,900,1]]) {
      await browser(session,['set','viewport',String(width),String(height)])
      const output=await browser(session,['get','cdp-url']),endpoint=output.match(/ws:\/\/\S+/)?.[0];assert.ok(endpoint)
      const client=await openCdpClient(endpoint)
      try {
        const {targetInfos}=await client.send('Target.getTargets'),page=targetInfos.find(target=>target.type==='page'&&target.url.startsWith(url));assert.ok(page)
        const {sessionId}=await client.send('Target.attachToTarget',{targetId:page.targetId,flatten:true})
        await client.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile:label==='iphone-pwa'},sessionId)
      await browser(session,['eval',`(() => {
        const root=document.documentElement;root.style.setProperty('--post-safe-top','${label==='iphone-pwa'?59:0}px');root.style.setProperty('--post-safe-bottom','${label==='iphone-pwa'?34:0}px');
        const replace=css=>css.replace(/env\\(safe-area-inset-(top|bottom|left|right)(?:\\s*,[^)]*)?\\)/g,(_,edge)=>edge==='top'||edge==='bottom'?'var(--post-safe-'+edge+')':'0px');
        for(const sheet of document.styleSheets) { try { for(let index=sheet.cssRules.length-1;index>=0;index--) { const text=sheet.cssRules[index].cssText;if(text.includes('safe-area-inset-')) {sheet.deleteRule(index);sheet.insertRule(replace(text),index)} } } catch {} }
        for(const node of document.querySelectorAll('[style]')) {const style=node.getAttribute('style');if(style.includes('safe-area-inset-')) node.setAttribute('style',replace(style))}
        Object.defineProperty(navigator,'standalone',{configurable:true,get:()=>${label==='iphone-pwa'}});
        window.dispatchEvent(new Event('resize'));
        return true;
      })()`])
      await browser(session,['eval','document.querySelector("[role=\\"alert\\"]").scrollIntoView({block:"center"})'])
      await browser(session,['wait','500'])
      await browser(session,['screenshot',path.join(evidence,`${label}.png`)])
      const metrics=await browser(session,['eval','JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,warning:document.body.innerText.includes("Last available: week 24")})'])
      let layout=JSON.parse(metrics);if(typeof layout==='string') layout=JSON.parse(layout)
      assert.equal(layout.width,width);assert.equal(layout.height,height);assert.equal(layout.dpr,dpr);assert.ok(layout.scrollWidth<=width);assert.ok(layout.warning)
      layouts.push({label,...layout})
      writeFileSync(path.join(evidence,`${label}.json`),JSON.stringify(layout,null,2)+'\n')
      } finally {client.close()}
    }
    writeFileSync(path.join(evidence,'report.json'),JSON.stringify({provenance:'SYNTHETIC local commissioner and calendar',tapsFromMainSettings:taps,textEdits:1,layouts,warningAppearsBeforeSave:true,nativeSafariVerified:false},null,2)+'\n')
  } catch(error) {
    writeFileSync(path.join(evidence,'failure-network.txt'),await browser(session,['eval',`JSON.stringify(performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.includes('/auth/')))`]).catch(()=>''))
    writeFileSync(path.join(evidence,'failure-snapshot.txt'),await browser(session,['snapshot']).catch(()=>''));throw error
  } finally {
    await browser(session,['close']).catch(()=>{})
    let sessions = await listBrowserSessions()
    for(let attempt=0;attempt<20 && sessions.includes(session);attempt++) {
      await new Promise(resolve=>setTimeout(resolve,250)); sessions=await listBrowserSessions()
    }
    writeFileSync(path.join(evidence,'sessions-after.txt'),sessions)
    web.kill('SIGTERM')
    if(fixtureCreated) sql(`BEGIN; DELETE FROM leagues WHERE id='${league}'; DELETE FROM season_weeks WHERE season_year=9527; COMMIT;`)
    if(userCreated) await fetch(keys.API_URL+'/auth/v1/admin/users/'+user,{method:'DELETE',headers:{apikey:keys.ANON_KEY,Authorization:`Bearer ${keys.SERVICE_ROLE_KEY}`}})
  }
}

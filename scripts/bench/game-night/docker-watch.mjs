import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { command, delay } from './common.mjs'

export function containerStart(event, project) {
  if(event.Type!=='container' || event.Action!=='start')return null
  const attributes=event.Actor?.Attributes ?? {}
  if(attributes['com.supabase.cli.project']===project)return null
  return {at:Number(event.timeNano)/1000000 || Number(event.time)*1000,id:event.Actor?.ID,name:attributes.name ?? '',image:attributes.image ?? ''}
}

export async function watchDocker(project) {
  const started=Date.now(),events=[]
  let buffer='',error='',closed=false
  const inventory=(await command('docker',['ps','--format','{{json .}}'])).stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
  const initial=inventory.filter(row=>!row.Labels?.split(',').includes(`com.supabase.cli.project=${project}`))
    .map(row=>({id:row.ID,name:row.Names,status:row.Status}))
  const child=spawn('docker',['events','--since',String(Math.floor(started/1000)),'--filter','type=container','--filter','event=start','--format','{{json .}}'],{stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',data=>{
    buffer+=data.toString()
    let end
    while((end=buffer.indexOf('\n'))!==-1) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
      try {const event=containerStart(JSON.parse(line),project);if(event)events.push(event)}
      catch {error='Cannot parse Docker event'}
    }
  })
  child.stderr.on('data',data=>{error=(error+data.toString()).slice(-2000)})
  child.on('error',failure=>{error=failure.message})
  await Promise.race([once(child,'spawn'),once(child,'error').then(([failure])=>Promise.reject(failure))])
  await delay(100)
  const close=async()=>{
    if(closed)return
    closed=true
    if(child.exitCode==null && child.signalCode==null){const ended=once(child,'close');child.kill('SIGTERM');await ended}
  }
  return {started,initial,events,close,result:ended=>({started,ended,initial,events:events.filter(event=>event.at>=started-1000 && event.at<=ended),error,
    passed:!error && (closed || child.exitCode==null && child.signalCode==null)})}
}

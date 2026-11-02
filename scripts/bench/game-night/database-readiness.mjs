import { delay } from './common.mjs'

export async function waitForDatabaseReady(query,health,{attempts=120,wait=()=>delay(500)}={}) {
  let reason='No readiness check completed'
  for(let attempt=0;attempt<attempts;attempt++) {
    try {
      const status=await health()
      reason=`Docker health is ${status}`
      if(status==='healthy') {
        await query()
        return
      }
    } catch(error) {reason=error.message}
    if(attempt+1<attempts)await wait()
  }
  throw new Error(`The local database is not ready: ${reason}`)
}

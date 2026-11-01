import { command, delay } from './common.mjs'

async function waitForQuietDocker() {
  let quietSince=Date.now()
  console.log('Waiting for sixty quiet seconds before the next measured run.')
  while(Date.now()-quietSince<60000) {
    if((await command('docker',['ps','-q'])).stdout.trim())quietSince=Date.now()
    await delay(5000)
  }
}

export async function isolatedReplay(run,quiet=waitForQuietDocker) {
  for(let attempt=1;;attempt++) {
    await quiet()
    const report=await run(attempt)
    if(!report.swap.foreignContainerActivityObserved)return report
    console.log(`${report.label}: foreign Docker activity invalidates this sample; preserving it and retrying.`)
  }
}

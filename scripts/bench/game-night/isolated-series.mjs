import assert from 'node:assert/strict'
import { delay } from './common.mjs'

export async function isolatedReplay(run,before=async()=>{}) {
  for(let attempt=1;;attempt++) {
    await before()
    const report=await run(attempt)
    assert.ok(typeof report.resources?.hostMemory.passed==='boolean','Host memory headroom is unknown')
    if(report.resources?.hostMemory.passed)return report
    console.log(`${report.label}: VM available memory fell below the fixed floor; preserving this sample and retrying.`)
    await delay(1000)
  }
}

import assert from 'node:assert/strict'

export const resourceGraderVersion='game-night-cgroup-v1'
export const hostAvailableFloorBytes=1073741824

export function resourceGrade(samples) {
  assert.ok(samples.length>=2,'Resource grading requires two observations')
  const first=samples[0],last=samples.at(-1)
  const seconds=(last.at-first.at)/1000
  assert.ok(seconds>0,'Resource observation time must advance')
  const delta=name=>{
    assert.ok(Number.isFinite(first.cgroup[name]) && Number.isFinite(last.cgroup[name]),`Missing cgroup counter ${name}`)
    const value=last.cgroup[name]-first.cgroup[name]
    assert.ok(value>=0,`Cgroup counter reset: ${name}`)
    return value
  }
  const counters={}
  for(const name of ['pgmajfault','pswpout','swapout','zswpin','zswpout','zswpwb','swpin_zero','swpout_zero','thp_swpout','thp_swpout_fallback']) {
    if(Number.isFinite(first.cgroup[name]) && Number.isFinite(last.cgroup[name])) {
      const value=delta(name)
      counters[name]={delta:value,perSecond:value/seconds}
    }
  }
  const available=samples.map(row=>Number.isFinite(row.vmMemory?.availableBytes)?row.vmMemory.availableBytes:null)
  const free=samples.map(row=>row.vmMemory?.freeBytes ?? row.vm.nr_free_pages*4096)
  const complete=available.every(value=>value!==null)
  const lowerBound=Math.min(...free)
  const minimumAvailableBytes=complete?Math.min(...available):null
  const passed=complete?minimumAvailableBytes>=hostAvailableFloorBytes:lowerBound>=hostAvailableFloorBytes?true:null
  return {
    version:resourceGraderVersion,
    primary:{name:'cgroupAnonRefaultsPerSecond',counter:'memory.stat workingset_refault_anon',delta:delta('workingset_refault_anon'),seconds,value:delta('workingset_refault_anon')/seconds},
    perCgroupCounters:counters,
    swapOutCounterAvailable:Object.hasOwn(counters,'pswpout') || Object.hasOwn(counters,'swapout'),
    hostMemory:{passed,floorBytes:hostAvailableFloorBytes,minimumAvailableBytes,minimumFreeBytes:lowerBound,
      source:complete?'/proc/meminfo MemAvailable':'Historical /proc/vmstat free pages provide a lower bound only',
      unknownSamples:available.filter(value=>value===null).length},
  }
}

export function regradeResources(report) {
  const resources=resourceGrade(report.observations)
  return {...report,originalGrade:{grader:report.grader,passed:report.passed},resources,
    grader:{...report.grader,resourceVersion:resourceGraderVersion},
    swap:{...report.swap,cgroupAnonRefaultsPerSecond:resources.primary.value},
    passed:Boolean(report.passed && resources.hostMemory.passed)}
}

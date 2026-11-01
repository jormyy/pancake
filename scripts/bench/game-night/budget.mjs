import { percentile } from './measure.mjs'

export function projectBudget(report) {
  const seconds=6*3600*30
  const scale=seconds/report.seconds
  const row=(value,limit,unit,source)=>({value,limit,unit,fraction:value/limit,riskOverHalf:value>limit/2,source})
  const publicFeed=report.publicFeed
  const phones=report.phones
  if(!publicFeed || !phones)return null
  const source=publicFeed.origins
  const bytes=percentile(source.map(value=>value.bytes),.5) ?? 0
  const gzip=percentile(source.map(value=>value.gzipBytes).filter(Number.isFinite),.5) ?? null
  const requests=publicFeed.requests*scale
  const invocations=source.length*scale
  const worstInvocations=Math.min(requests,invocations*11)
  const cpu=source.reduce((sum,value)=>sum+value.cpuMicroseconds,0)/3600000000*scale
  const memoryHours=source.reduce((sum,value)=>sum+value.milliseconds,0)/3600000*scale*2
  const workerBytes=(report.workerDataTransfer?.requests ?? []).reduce((sum,value)=>sum+value.responseBytes,0)
  const deliveries=phones.messages.length
  return {
    basis:{phones:10,hoursPerNight:6,nights:30,peakWindowHeldConstant:true,cacheRegionsUpperBound:11,
      assumptions:['Vercel CPU and duration use the local fake-feed route, not deployed billing measurements.',
        'The upper cache bound permits one independent region per phone and worker.',
        'Supabase transfer sums decoded API bodies and delivered broadcasts; header and TLS bytes are excluded.',
        'Realtime message estimate adds delivered broadcasts and an upper bound of one send per delivery.']},
    payload:{medianBytes:bytes,medianGzipBytes:gzip},
    vercel:{
      requests:row(requests,1000000,'requests','https://vercel.com/docs/plans/hobby'),
      invocations:row(worstInvocations,1000000,'invocations','https://vercel.com/docs/plans/hobby'),
      oneRegionInvocations:invocations,
      transfer:row(requests*(gzip ?? bytes),100e9,'bytes','https://vercel.com/docs/plans/hobby'),
      originTransfer:row(worstInvocations*bytes,10e9,'bytes','https://vercel.com/docs/plans/hobby'),
      activeCpu:row(cpu*Math.min(11,requests/Math.max(invocations,1)),4,'hours','https://vercel.com/docs/plans/hobby'),
      memory:row(memoryHours*Math.min(11,requests/Math.max(invocations,1)),360,'GB-hours at 2 GB allocation','https://vercel.com/docs/plans/hobby'),
    },
    supabase:{
      database:row(report.shape.databaseBytes,500e6,'bytes','https://supabase.com/pricing'),
      memory:row(report.memory.cgroupAnonPeakBytes+report.memory.cgroupShmemPeakBytes,500e6,'sampled anon plus shared bytes','https://supabase.com/pricing'),
      diskIo:row(report.diskIo.readsPerSecond+report.diskIo.writesPerSecond,250,'operations per second','CONTRACT.md observed production baseline, not a Free-plan quota'),
      transfer:row((workerBytes+phones.viewBytes+phones.messageBytes)*scale,5e9,'decoded payload bytes','https://supabase.com/pricing'),
      edgeInvocations:row(report.edgeRequestCount*scale,500000,'invocations including API reads','https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations'),
      realtimeMessages:row((deliveries*2)*scale,2000000,'messages upper estimate','https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages'),
      realtimeConnections:row(10,200,'simultaneous phone connections; lab adds one observer','https://supabase.com/docs/guides/realtime/limits'),
    },
    observedBroadcasts:{deliveries},
  }
}

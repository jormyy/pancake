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
  const phoneWireBytes=phones.viewWireBytes ?? phones.viewBytes
  const homeReads=(phones.viewReads ?? []).filter(row=>row.kind==='home')
  const openingReads=10*30
  const openingPhoneBytes=openingReads*(percentile(homeReads.map(row=>row.wireBytes ?? row.bytes),.95) ?? 0)
  const openingInternalBytes=openingReads*(percentile(homeReads.map(row=>row.bytes),.95) ?? 0)
  const recoveryCalls=phones.architecture ? Math.max(0,10*seconds/600-(phones.viewReads ?? []).filter(row=>row.kind==='version').length*scale) : 0
  const recoveryTransfer=recoveryCalls*16384
  const deliveries=phones.messages.length
  const sendCalls=at=>(report.functionCounters?.[at] ?? []).filter(row=>row.schemaname==='realtime' && row.funcname==='send').reduce((sum,row)=>sum+Number(row.calls),0)
  const sends=Math.max(report.realtime?.messages ?? 0,report.functionCounters ? sendCalls('after')-sendCalls('before') : Math.ceil(deliveries/10))
  const memorySamples=(report.observations ?? []).map(sample=>sample.current).filter(Number.isFinite)
  const memoryBytes=memorySamples.length?Math.max(...memorySamples):report.memory.cgroupAnonPeakBytes+report.memory.cgroupShmemPeakBytes
  const budget={
    version:'game-night-budget-v3',
    basis:{phones:10,hoursPerNight:6,nights:30,peakWindowHeldConstant:true,cacheRegionsUpperBound:11,
      assumptions:['Vercel CPU and duration use the local fake-feed route, not deployed billing measurements.',
        'The upper cache bound permits one independent region per phone and worker.',
        'Supabase transfer sums measured encoded phone responses, conservative decoded database-to-Edge responses and delivered broadcasts; header and TLS bytes are excluded.',
        'Realtime counts each database send once plus delivered phone messages, per the published billing rule. Personal-channel delivery is measured; older reports use a ten-recipient upper bound.',
        'One cold screen opening per phone per night adds 300 API calls and both transfer legs.']},
    recoveryReserve:{calls:recoveryCalls,bytes:recoveryTransfer,intervalSeconds:600,
      basis:'Adds missing ten-minute recovery reads beyond the observed window, with an 8 KiB response allowance on each transfer leg.'},
    payload:{medianBytes:bytes,medianGzipBytes:gzip},
    vercel:{
      requests:row(requests,1000000,'requests','https://vercel.com/docs/limits'),
      invocations:row(worstInvocations,1000000,'invocations','https://vercel.com/docs/limits'),
      oneRegionInvocations:invocations,
      twoRegionInvocations:Math.min(requests,invocations*2),
      transfer:row(requests*(gzip ?? bytes),100e9,'bytes','https://vercel.com/docs/limits'),
      originTransfer:row(worstInvocations*bytes,10e9,'bytes','https://vercel.com/docs/limits'),
      activeCpu:row(cpu*Math.min(11,requests/Math.max(invocations,1)),4,'hours','https://vercel.com/docs/limits'),
      memory:row(memoryHours*Math.min(11,requests/Math.max(invocations,1)),360,'GB-hours at 2 GB allocation','https://vercel.com/docs/limits'),
    },
    supabase:{
      database:row(report.databaseGrowth?.after.databaseBytes ?? report.shape.databaseBytes,500e6,'bytes','https://supabase.com/pricing'),
      memory:row(memoryBytes,500e6,memorySamples.length?'peak sampled cgroup memory.current bytes':'sum of separate anon and shared peaks; upper bound','https://supabase.com/docs/guides/platform/compute-and-disk'),
      diskIo:row(report.diskIo.readsPerSecond+report.diskIo.writesPerSecond,250,'operations per second','https://supabase.com/docs/guides/platform/compute-and-disk; Nano sustained baseline, not a monthly quota'),
      transfer:row((workerBytes+phoneWireBytes+phones.messageBytes)*scale+openingPhoneBytes+openingInternalBytes+recoveryTransfer,5e9,'encoded phone bytes plus conservative decoded internal bytes and recovery reserve','https://supabase.com/pricing'),
      edgeInvocations:row(report.edgeRequestCount*scale+openingReads+recoveryCalls,500000,'invocations including API reads, nightly opens and recovery reserve','https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations'),
      realtimeMessages:row((phones.personalChannels?sends+deliveries:Math.max(sends+deliveries,sends*11))*scale,2000000,
        phones.personalChannels?'database sends plus observed league, member and user deliveries':'sent messages plus a conservative ten-phone delivery bound',
        'https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages'),
      realtimeConnections:row(10,200,'simultaneous phone connections; lab adds one observer','https://supabase.com/docs/guides/realtime/limits'),
    },
    databaseGrowth:report.databaseGrowth ?? null,
    namedRisks:[...(report.shape.databaseBytes>250e6?['Database size and retention: the fixed fixture exceeds half the 500 MB Free allowance. Timed allocation includes reusable pages and must not be extrapolated linearly as permanent row growth. Successful-job and broadcast retention stay bounded; official stats and results stay protected.']:[])],
    observedBroadcasts:{sends,deliveries,tenRecipientUpperBound:sends*11*scale,previousDoubleDeliveryUpperBound:deliveries*2*scale},
    transferAccounting:{phoneWireBytes,phoneDecodedBytes:phones.viewBytes,internalDecodedBytes:workerBytes,
      gzipVerified:phones.compressionVerified===true,openingReads,
      monthlyDecodedUpperBound:(workerBytes+phones.viewBytes+phones.messageBytes)*scale+openingInternalBytes*2+recoveryTransfer,
      billingCompression:'Official documentation defines network packets leaving the service. API-specific gzip metering is not explicitly documented; the decoded upper bound remains visible.'},
  }
  budget.vercelWithinHalfLimits=Object.values(budget.vercel).every(value=>typeof value!=='object' || value.fraction<=.5)
  budget.vercelInvocationTarget=budget.vercel.invocations.fraction<=.25
  budget.supabaseQuarterTargets=budget.supabase.edgeInvocations.fraction<=.25 && budget.supabase.realtimeMessages.fraction<=.25
  budget.supabaseWithinHalfLimits=Object.entries(budget.supabase).filter(([name])=>name!=='database').every(([,value])=>value.fraction<=.5)
  budget.supabaseWithinLimits=Object.values(budget.supabase).every(value=>value.fraction<=1)
  budget.namedRisks.push(...Object.entries(budget.supabase).filter(([name,value])=>name!=='database' && value.riskOverHalf)
    .map(([name,value])=>`Supabase ${name}: ${Math.round(value.fraction*1000)/10}% of the Free limit under the stated peak-window projection.`))
  budget.namedRisks.push(...Object.entries(budget.vercel).flatMap(([name,value])=>value && typeof value==='object' && value.riskOverHalf
    ? [`Vercel ${name}: ${Math.round(value.fraction*1000)/10}% of the Hobby limit exceeds the approved half-limit budget.`] : []))
  return budget
}

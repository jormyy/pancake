export async function trackWorkerWait(owner,kind,target,operation){
  const key={}
  owner?.io.set(key,{kind,target})
  try{return await operation()}finally{owner?.io.delete(key)}
}

export function workerHealth(requests,timers,now){
  return [...requests].slice(0,32).map(state=>({id:state.id,function:state.function,invocation:state.invocation,elapsedMs:now-state.started,waits:[...state.io.values(),...(timers.inspect?.(state)??[])].slice(0,16)}))
}

import { stateAt } from './fixture.mjs'

export function checkpointGrade({slate,before,after,started,ended,intervalMs,work,origins,phonePolls}) {
  const final=stateAt(slate,(ended-started)/1000)
  const old=new Map(before.map(row=>[row.id,row]))
  const latest=new Map(after.map(row=>[row.id,row]))
  const failures=[]
  let transitions=0,checkpoints=0
  for(const game of final) {
    const initial=old.get(game.id),last=latest.get(game.id)
    if(game.gameStatus===3 && initial?.status!=='Final') {
      transitions++
      if(last?.status!=='Final')failures.push({game:game.id,reason:'Final status did not reach the database'})
    }
    if(initial?.status!=='InProgress' || game.gameStatus===3)continue
    const due=(initial.checkpoint_at ? Date.parse(initial.checkpoint_at) : started-intervalMs)+intervalMs
    if(due<=ended-30000) {
      checkpoints++
      if(!last?.checkpoint_at || Date.parse(last.checkpoint_at)<due)failures.push({game:game.id,reason:'Recovery checkpoint missed its interval'})
    }
  }
  const required={saved:Math.max(1,transitions+checkpoints),workerStarts:1,origins:2,phonePolls:10}
  return {...work,passed:work.saved>=required.saved && work.workerStarts>=required.workerStarts
    && origins>=required.origins && phonePolls>=required.phonePolls && failures.length===0,
    required,transitions,checkpoints,origins,phonePolls,failures}
}

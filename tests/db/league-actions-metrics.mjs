import assert from 'node:assert/strict'

export function percentile(values, fraction) {
  assert.ok(values.length > 0)
  return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1]
}

export function pairedComparisons(samples) {
  const groups = Map.groupBy(samples,row=>`${row.name}/${row.variant}/${row.manager}/${row.state}`)
  return [...groups.values()].map(rows => {
    const before = rows.filter(row=>row.version==='baseline')
    const after = rows.filter(row=>row.version==='candidate')
    assert.ok(before.length >= 5 && before.length === after.length, 'Each comparison needs five complete pairs')
    assert.equal(new Set(before.map(row=>row.round)).size,before.length,'Duplicate baseline round')
    assert.equal(new Set(after.map(row=>row.round)).size,after.length,'Duplicate candidate round')
    const pairs = before.map(row=>{
      const candidate=after.find(value=>value.round===row.round)
      assert.ok(candidate,'Missing paired candidate')
      assert.equal(row.window,candidate.window,'A pair cannot cross a database restart')
      return [row,candidate]
    })
    const metrics=Object.fromEntries(['milliseconds','buffers','statements','written','wal','bytes'].map(key=>{
      assert.ok(rows.every(row=>Number.isFinite(row[key]) && row[key]>=0),`Invalid ${key}`)
      const baseline=before.map(row=>row[key])
      const candidate=after.map(row=>row[key])
      const deltas=pairs.map(([a,b])=>b[key]-a[key])
      const spread=Math.max(...baseline)-Math.min(...baseline)
      const pairedSpread=Math.max(...deltas)-Math.min(...deltas)
      const threshold=Math.max(spread,percentile(baseline,0.5)*0.1,key==='milliseconds'?pairedSpread:0)
      const deltaP50=percentile(deltas,0.5)
      return [key,{beforeP50:percentile(baseline,0.5),afterP50:percentile(candidate,0.5),deltaP50,deltaP95:percentile(deltas,0.95),baselineSpread:spread,pairedSpread,threshold,gain:deltaP50 < -threshold,regression:deltaP50 > threshold}]
    }))
    const row=rows[0]
    return {name:row.name,variant:row.variant,manager:row.manager,state:row.state,pairs:pairs.length,metrics}
  })
}

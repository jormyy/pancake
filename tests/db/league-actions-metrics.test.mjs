import assert from 'node:assert/strict'
import test from 'node:test'
import { pairedComparisons } from './league-actions-metrics.mjs'

const fixture = () => Array.from({length:5},(_,round)=>['baseline','candidate'].map(version=>({name:'action',variant:'default',manager:1,state:'warm',round,version,milliseconds:version==='baseline'?100+round:10+round,buffers:version==='baseline'?1000:100,statements:10,written:0,wal:0,bytes:50}))).flat()

test('paired timing and work gains must exceed the frozen noise bound',()=>{
  const result=pairedComparisons(fixture())[0]
  assert.equal(result.pairs,5)
  assert.equal(result.metrics.milliseconds.deltaP50,-90)
  assert.equal(result.metrics.milliseconds.gain,true)
  assert.equal(result.metrics.buffers.gain,true)
  assert.equal(result.metrics.bytes.gain,false)
})

test('concurrent timing noise cannot hide a stable work reduction',()=>{
  const rows=fixture()
  for (const row of rows) row.milliseconds=row.version==='baseline'?100:80+row.round*10
  const result=pairedComparisons(rows)[0]
  assert.equal(result.metrics.milliseconds.gain,false)
  assert.equal(result.metrics.buffers.gain,true)
})

test('missing and duplicate pairs reject a comparison',()=>{
  assert.throws(()=>pairedComparisons(fixture().slice(1)))
  const rows=fixture()
  rows[2].round=rows[0].round
  assert.throws(()=>pairedComparisons(rows))
  const restarted=fixture()
  restarted[0].window='before restart'
  restarted[1].window='after restart'
  assert.throws(()=>pairedComparisons(restarted))
})

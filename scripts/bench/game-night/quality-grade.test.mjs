import test from 'node:test'
import assert from 'node:assert/strict'
import {qualityGrade} from './quality-grade.mjs'

const grade=freshness=>qualityGrade({actions:{records:[]},freshness,realtime:{},policies:{}})

test('missing phone observations fail freshness even when the observed p95 is fast',()=>{
  for(const passed of [false,undefined]) {
    const result=grade({passed,samples:90,p95Ms:25000,missing:[{phone:1,reason:'Score missed its freshness deadline'}]})
    assert.equal(result.gates.scoreFreshness.passed,false)
  }
})

test('complete phone observations and stored-score observations keep their freshness checks',()=>{
  assert.equal(grade({passed:true,samples:100,p95Ms:25000}).gates.scoreFreshness.passed,true)
  assert.equal(grade({samples:10,p95Ms:25000}).gates.scoreFreshness.passed,true)
  assert.equal(grade({samples:10,p95Ms:46000}).gates.scoreFreshness.passed,false)
})

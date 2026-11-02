import assert from 'node:assert/strict'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {json,readJson,repository} from './common.mjs'
import {regradeResources} from './resource-grade.mjs'
import {distribution} from './summary.mjs'

const {values}=parseArgs({options:{input:{type:'string',multiple:true},output:{type:'string'}}})
assert.ok(values.input?.length && values.output,'Provide input reports and an output directory')
assert.ok(path.relative(repository,path.resolve(values.output)).startsWith('..'),'Regrades belong outside the repository')
const reports=[]
for(const file of values.input) {
  const report=regradeResources(await readJson(file))
  reports.push(report)
  await json(path.join(values.output,path.basename(file)),{...report,regradedFrom:path.resolve(file)})
}
await json(path.join(values.output,'summary.json'),{n:reports.length,metric:'cgroupAnonRefaultsPerSecond',
  primary:distribution(reports.map(row=>row.resources.primary.value)),
  historical:true,acceptedForNewComparison:false,
  hostMemory:reports.map(row=>({label:row.label,...row.resources.hostMemory})),
  originalQuality:reports.map(row=>row.originalGrade)})

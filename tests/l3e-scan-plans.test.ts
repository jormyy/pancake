import { expect, it } from 'vitest'
import { scanPlans } from './db/l3e-plan-audit.mjs'

it('counts rows rejected by a filter across repeated nested scans', () => {
  const source = 'NOTICE: duration: 1.25 ms plan: ' + JSON.stringify({ 'Query Text': 'SELECT \'{quoted}\'', Plan: { 'Node Type': 'Nested Loop', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'players', 'Actual Rows': 2, 'Rows Removed by Filter': 98, 'Actual Loops': 4, 'Shared Hit Blocks': 12 }] } })
  expect(scanPlans(source)).toEqual([{ query: "SELECT '{quoted}'", milliseconds: 1.25, scans: [{ table: 'players', loops: 4, rowsRead: 400, filter: null, buffers: 12 }] }])
})

it('excludes scans that never execute and small untargeted tables', () => {
  const source = 'duration: 2 ms plan: ' + JSON.stringify({ Plan: { Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'players', 'Actual Loops': 0 }, { 'Node Type': 'Seq Scan', 'Relation Name': 'work_kinds', 'Actual Rows': 10, 'Actual Loops': 1 }] } })
  expect(scanPlans(source)).toEqual([])
})

it('handles adjacent log plans with escaped quotes in query text', () => {
  const plan = { 'Query Text': 'SELECT \'"}\\\'', Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'work_items', 'Actual Rows': 3, 'Actual Loops': 1 } }
  expect(scanPlans(`duration: 1 ms plan: ${JSON.stringify(plan)}\nCONTEXT: function\nduration: 2 ms plan: ${JSON.stringify(plan)}`)).toHaveLength(2)
})

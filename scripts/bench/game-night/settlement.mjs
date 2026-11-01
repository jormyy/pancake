import assert from 'node:assert/strict'
import { groupStatements, statementDeltas } from './measure.mjs'

export function settlementCosts(start,end) {
  const seconds=(Date.parse(end.at)-Date.parse(start.at))/1000
  assert.ok(seconds>=0,'Settlement clock moves backward')
  assert.equal(start.statementInfo.stats_reset,end.statementInfo.stats_reset,'Settlement statement counters reset')
  const statements=statementDeltas(start.statements,end.statements)
  const walBytes=Number(end.wal.wal_bytes)-Number(start.wal.wal_bytes)
  const sessions=Number(end.database.sessions)-Number(start.database.sessions)
  assert.ok(walBytes>=0 && sessions>=0,'Settlement counters move backward')
  return {scope:'after the timed window through worker drain; excluded from primary measurements',
    startedAt:start.at,endedAt:end.at,seconds,walBytes,newSessions:sessions,
    databaseBytes:end.storage.databaseBytes-start.storage.databaseBytes,
    statementExecSecondsPerMinuteByFunction:seconds>0?groupStatements(statements,seconds/60):[],
    statements}
}

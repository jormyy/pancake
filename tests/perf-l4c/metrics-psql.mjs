#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

if (process.env.PGHOST !== '127.0.0.1' || process.env.PGPORT !== '63022') throw new Error('Use the L4c database')
const child = spawn('psql', process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] })
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  if (line.startsWith('\\echo season_sim_')) child.stdin.write(`RESET statement_timeout;
RESET lock_timeout;
DO $l4c_flush$ BEGIN PERFORM pg_stat_force_next_flush(); END $l4c_flush$;
DO $l4c_observe$ BEGIN
  IF to_regprocedure('perf_lab.observe_boundary()') IS NOT NULL THEN PERFORM perf_lab.observe_boundary(); END IF;
END $l4c_observe$;\n`)
  child.stdin.write(`${line}\n`)
})
lines.on('close', () => child.stdin.end())
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1; lines.close() })

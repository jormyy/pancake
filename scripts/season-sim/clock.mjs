import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { assertTarget, laneDirectory, miniRoot, writeJson } from './common.mjs'
import { clockTime } from './virtual-clock.mjs'
import { sql } from './local-stack.mjs'

export async function setClock(options) {
  const db = process.env.SUPABASE_DB_URL
  assert.ok(db, 'SUPABASE_DB_URL is required')
  assertTarget(db, 'db')
  assertTarget(process.env.SUPABASE_URL, 'api')
  const directory = await laneDirectory(options.state ?? path.join(miniRoot, 'state'))
  const state = { simMs: Date.parse(options.at), realMs: Date.now(), rate: Number(options.rate ?? 0), capMs: options.capAt == null ? null : Date.parse(options.capAt) }
  clockTime(state, state.realMs)
  if (options.install) {
    const source = await readFile(new URL('./clock.sql', import.meta.url), 'utf8')
    await sql(source.slice(source.indexOf('BEGIN;')).replaceAll(":'sim_ms'", String(state.simMs)).replaceAll(":'real_ms'", String(state.realMs)).replaceAll(":'rate'", String(state.rate)).replaceAll(":'cap_ms'", state.capMs == null ? 'NULL' : String(state.capMs)))
  } else {
    const result = await sql(`UPDATE season_sim.clock SET sim_ms=${state.simMs},real_ms=${state.realMs},rate=${state.rate},cap_ms=${state.capMs == null ? 'NULL' : state.capMs} WHERE singleton RETURNING singleton`)
    assert.equal(result.trim(), 't', 'The simulator clock is not installed')
  }
  await writeJson(path.join(directory, 'clock.json'), state)
  if (!options.quiet) console.log(JSON.stringify({ event: 'clock', at: options.at, rate: state.rate, capAt: options.capAt ?? null }))
}

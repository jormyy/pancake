import path from 'node:path'
import { json } from './common.mjs'
import { sql } from './database.mjs'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

export function conflictProviderIds(message) {
  return [...new Set([...message.matchAll(/espn provider (\d+): ambiguous identity/g)].map(match => match[1]))]
}

export function identityPairResults(pairs, rows) {
  return pairs.map(pair => {
    const owners = rows.filter(row => row.nba_id === pair.nbaId || row.sleeper_id === pair.sleeperId || pair.candidateIds.includes(row.id))
    return { ...pair, owners, merged: owners.length === 1 && owners[0].nba_id === pair.nbaId
      && owners[0].sleeper_id === pair.sleeperId && owners[0].espn_id === pair.espnId }
  })
}

export async function captureIdentityPairs(evidence) {
  const pairs = JSON.parse(await readFile(new URL('./baselines/identity-pairs.json', import.meta.url), 'utf8'))
  assert.ok(pairs.every(row => [row.nbaId, row.sleeperId, row.espnId].every(id => /^\d+$/.test(id))
    && row.candidateIds.every(id => /^[a-f0-9-]{36}$/.test(id))), 'Invalid identity fixture')
  const nba = pairs.map(row => `'${row.nbaId}'`).join(',')
  const sleeper = pairs.map(row => `'${row.sleeperId}'`).join(',')
  const ids = pairs.flatMap(row => row.candidateIds).map(id => `'${id}'`).join(',')
  const rows = JSON.parse(await sql(`SELECT coalesce(json_agg(p),'[]') FROM (
    SELECT id,display_name,nba_id,sleeper_id,espn_id FROM public.players WHERE nba_id IN (${nba}) OR sleeper_id IN (${sleeper}) OR id IN (${ids})
  ) p`))
  const results = identityPairResults(pairs, rows)
  const report = { passed: results.every(row => row.merged), results }
  await json(path.join(evidence, 'identity-repair.json'), report)
  return report
}

export async function captureIdentityConflicts(error, evidence) {
  const ids = conflictProviderIds(error.message)
  if (!ids.length) return
  const rows = JSON.parse(await sql(`WITH affected AS (
    SELECT nba_id,lower(first_name) AS first_name,lower(last_name) AS last_name
    FROM players WHERE espn_id IN (${ids.map(id => `'${id}'`).join(',')})
  ) SELECT coalesce(json_agg(record),'[]') FROM (
    SELECT id,display_name,first_name,last_name,birthdate,nba_team,nba_id,espn_id,sleeper_id,sportsdata_id
    FROM players p WHERE espn_id IN (${ids.map(id => `'${id}'`).join(',')})
      OR nba_id IN (SELECT nba_id FROM affected)
      OR (lower(first_name),lower(last_name)) IN (SELECT first_name,last_name FROM affected)
    ORDER BY display_name,id
  ) record`))
  await json(path.join(evidence, 'identity-conflicts.json'), { provider: 'espn', ids, rows })
}

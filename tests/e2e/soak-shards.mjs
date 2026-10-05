import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// A release soak too long for one job runs as a chain of shards. Each shard runs a
// contiguous block of the same simulated seasons and hands the next one the database
// volume plus this checkpoint, so every cross-season check sees one continuous run.
export const CHECKPOINT_SCHEMA_VERSION = 1

/** @param {number} totalSeasons @param {number} shardCount */
export const planSoakShards = (totalSeasons, shardCount) => {
  if (!Number.isInteger(totalSeasons) || totalSeasons < 1) throw new Error('Soak shards need a positive season count')
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > totalSeasons) {
    throw new Error(`Soak shard count must be between 1 and ${totalSeasons}`)
  }
  const base = Math.floor(totalSeasons / shardCount)
  const extra = totalSeasons % shardCount
  const shards = []
  let firstSeason = 1
  for (let shard = 1; shard <= shardCount; shard += 1) {
    const size = base + (shard <= extra ? 1 : 0)
    shards.push({ shard, shardCount, firstSeason, lastSeason: firstSeason + size - 1 })
    firstSeason += size
  }
  return shards
}

/** @param {string | undefined} value @param {number} totalSeasons */
export const resolveSoakShard = (value, totalSeasons) => {
  if (value === undefined || value === '') {
    return { shard: 1, shardCount: 1, firstSeason: 1, lastSeason: totalSeasons }
  }
  const match = String(value).match(/^(\d+)\/(\d+)$/)
  if (!match) throw new Error(`--shard must look like K/N, got ${value}`)
  const shard = Number(match[1])
  const shardCount = Number(match[2])
  const plan = planSoakShards(totalSeasons, shardCount)
  if (shard < 1 || shard > shardCount) throw new Error(`--shard ${value} is outside 1..${shardCount}`)
  return plan[shard - 1]
}

/** @param {string} root */
const checkpointPath = (root) => path.join(root, 'tests/artifacts/soak-checkpoint.json')

/** @param {string} root */
export const readCheckpoint = async (root) => {
  const file = checkpointPath(root)
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8'))
}

/** @param {string} root @param {object} checkpoint */
export const writeCheckpoint = async (root, checkpoint) => {
  const file = checkpointPath(root)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(checkpoint, null, 2)}\n`)
}

/** @param {{ season: number }[]} items @param {number} through */
const seasonSequenceFailures = (label, items, through) => {
  const seasons = items.map((item) => Number(item?.season))
  const expected = Array.from({ length: through }, (_, index) => index + 1)
  if (seasons.length === expected.length && seasons.every((season, index) => season === expected[index])) return []
  const seen = new Set()
  const duplicates = seasons.filter((season) => seen.has(season) || !seen.add(season))
  const missing = expected.filter((season) => !seen.has(season))
  const unexpected = seasons.filter((season) => !expected.includes(season))
  return [`${label} seasons must be exactly 1..${through} in order` +
    `${missing.length ? `; missing ${missing.join(', ')}` : ''}` +
    `${duplicates.length ? `; duplicate ${duplicates.join(', ')}` : ''}` +
    `${unexpected.length ? `; unexpected ${unexpected.join(', ')}` : ''}`]
}

/** Rows of a finished run: every season exactly once, in order, each PASS. */
export const completedSoakFailures = (rows, totalSeasons) => {
  const seasonRows = rows.filter((row) => Number(row.season) !== 0)
  const failures = seasonSequenceFailures('Soak result', seasonRows, totalSeasons)
  const notPassing = seasonRows.filter((row) => row.status !== 'PASS').map((row) => row.season)
  if (notPassing.length) failures.push(`Soak seasons did not pass: ${notPassing.join(', ')}`)
  return failures
}

/**
 * The checkpoint a shard resumes from must come from the same release and plan and
 * cover exactly the seasons and shards before it.
 */
export const checkpointFailures = (checkpoint, { releaseSha, planSha256, totalSeasons, shard, candidate }) => {
  if (shard.shard === 1) {
    return checkpoint ? ['Shard 1 must start without a soak checkpoint'] : []
  }
  if (!checkpoint) return [`Shard ${shard.shard} requires the checkpoint from shard ${shard.shard - 1}`]
  const failures = []
  const expect = (condition, message) => { if (!condition) failures.push(message) }
  expect(checkpoint.schemaVersion === CHECKPOINT_SCHEMA_VERSION, 'Soak checkpoint schema version is not supported')
  expect(Boolean(releaseSha) && checkpoint.releaseSha === releaseSha, 'Soak checkpoint comes from a different release SHA')
  expect(Boolean(planSha256) && checkpoint.migrationPlanSha256 === planSha256, 'Soak checkpoint comes from a different migration plan')
  expect(checkpoint.totalSeasons === totalSeasons, 'Soak checkpoint has a different season count')
  expect(checkpoint.shardCount === shard.shardCount, 'Soak checkpoint has a different shard count')
  expect(checkpoint.candidate?.frontendDigest === candidate.frontendDigest &&
    checkpoint.candidate?.edgeDigest === candidate.edgeDigest, 'Soak checkpoint was produced by a different candidate build')
  const plan = planSoakShards(totalSeasons, shard.shardCount)
  const shards = Array.isArray(checkpoint.shards) ? checkpoint.shards : []
  const expectedShards = plan.slice(0, shard.shard - 1)
  expect(shards.length === expectedShards.length && shards.every((done, index) =>
    done.shard === expectedShards[index].shard &&
    done.firstSeason === expectedShards[index].firstSeason &&
    done.lastSeason === expectedShards[index].lastSeason &&
    done.status === 'PASS'), `Soak checkpoint must record passing shards 1..${shard.shard - 1}`)
  const through = shard.firstSeason - 1
  failures.push(...completedSoakFailures(Array.isArray(checkpoint.rows) ? checkpoint.rows : [], through)
    .map((failure) => failure.replace('Soak result', 'Soak checkpoint')))
  failures.push(...seasonSequenceFailures('Soak checkpoint perf metric', Array.isArray(checkpoint.perfMetrics) ? checkpoint.perfMetrics : [], through))
  expect(checkpoint.previousSnapshot?.counts && typeof checkpoint.previousSnapshot.counts === 'object',
    'Soak checkpoint is missing the previous season snapshot')
  expect(checkpoint.fakeUpstream && Array.isArray(checkpoint.fakeUpstream.players) && Array.isArray(checkpoint.fakeUpstream.games),
    'Soak checkpoint is missing the fake upstream state')
  expect(checkpoint.scenarios && typeof checkpoint.scenarios === 'object', 'Soak checkpoint is missing scenario state')
  return failures
}

/**
 * Season evidence every completed season leaves behind, checked before a run reports PASS.
 * @param {string} root @param {number} totalSeasons
 * @param {(season: number) => string[]} [registryScenariosForSeason]
 */
export const seasonArtifactFailures = (root, totalSeasons, registryScenariosForSeason = (_season) => []) => {
  const failures = []
  for (let season = 1; season <= totalSeasons; season += 1) {
    const required = [
      `tests/artifacts/season-${season}/fake-upstream.json`,
      `tests/artifacts/season-${season}/dynasty-decision-tools.json`,
      `tests/snapshots/season-${season}/summary.json`,
      ...registryScenariosForSeason(season).map((scenario) => `tests/artifacts/registry/${scenario}-season-${season}.json`),
    ]
    for (const file of required) {
      if (!existsSync(path.join(root, file))) failures.push(`missing season ${season} artifact ${file}`)
    }
  }
  for (const extra of [totalSeasons + 1, totalSeasons + 2]) {
    if (existsSync(path.join(root, `tests/artifacts/season-${extra}`))) {
      failures.push(`unexpected season ${extra} artifacts beyond the ${totalSeasons}-season run`)
    }
  }
  return failures
}

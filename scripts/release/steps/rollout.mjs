import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { changedFunctions, configuredFunctions } from './changed-functions.mjs'
import { checkSource } from './preflight.mjs'
import { checkedFetch, digest, fullSha, marker, nonempty, readJson, requireValue, saveJson, sha256, sql, verifyFiles } from './runtime.mjs'

const migrationQuery = 'select version from supabase_migrations.schema_migrations order by version'
const invocationQuery = `select count(*)::int as errors from public.edge_invocations
where queued_at >= now() - interval '15 minutes'
and (status_code not between 200 and 299 or error_message is not null or worker_status = 'failed'
or (status_code is null and reconciled_at is not null))`

const frontendMarker = ctx => new URL('/release-provenance.json', ctx.config.frontendUrl)
const edgeMarker = ctx => new URL(`${ctx.config.edgeUrl.replace(/\/$/, '')}/health`)
const localFile = (ctx, name) => path.join(ctx.directory, name)
const resultOf = (ctx, name) => ctx.state.completed[name]

async function git(ctx, args) { return (await ctx.run('git', args, ctx.root)).stdout.trim() }

async function edgePlan(ctx) {
  const changed = (await git(ctx, ['diff', '--name-only', 'origin/main...HEAD', '--', 'supabase/functions'])).split('\n').filter(Boolean)
  const files = (await git(ctx, ['ls-files', 'supabase/functions', 'core/src'])).split('\n').filter(file => /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !/\.test\./.test(file))
  const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(path.join(ctx.root, file), 'utf8')])))
  const config = await readFile(path.join(ctx.root, 'supabase/config.toml'), 'utf8')
  const functions = changedFunctions(changed, sources, configuredFunctions(config))
  return [...new Set([...functions, 'api'])].sort()
}

async function archive(ctx, sha, target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true, mode: 0o700 })
  const tar = `${target}.tar`
  await ctx.run('git', ['archive', '--format=tar', `--output=${tar}`, sha], ctx.root)
  await ctx.run('tar', ['-xf', tar, '-C', target], ctx.root)
  await rm(tar)
}

async function stamp(ctx, root, sha) {
  const { stampEdgeReleaseProvenance } = await import(pathToFileURL(path.join(ctx.root, 'scripts/stamp-edge-release-provenance.mjs')).href)
  return stampEdgeReleaseProvenance({
    commitSha: sha, artifactRoot: root, functionsRoot: path.join(root, 'supabase/functions'),
    metadataPath: path.join(root, 'supabase/functions/_shared/releaseMetadata.ts'),
    deploymentInputPaths: [path.join(root, 'supabase/config.toml'), path.join(root, 'deno.lock')],
  })
}

async function hashTree(root, prefix = '') {
  const files = {}
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(files, await hashTree(root, relative))
    else {
      requireValue(entry.isFile(), `Artifact contains a non-file: ${relative}`)
      files[relative] = sha256(await readFile(path.join(root, relative)))
    }
  }
  return files
}

export async function backup(ctx) {
  const frontend = await marker(ctx, frontendMarker(ctx), 'Frontend')
  const edge = await marker(ctx, edgeMarker(ctx), 'Edge')
  const functions = await edgePlan(ctx)
  const migrations = await sql(ctx, migrationQuery)
  await saveJson(localFile(ctx, 'migration-list.json'), migrations)
  for (const [name, extra] of [['schema.sql', []], ['data.sql', ['--data-only', '--use-copy', '--schema', 'public,private,analytics']]]) {
    const file = localFile(ctx, name)
    await ctx.run('supabase', ['db', 'dump', ctx.dryRun ? '--local' : '--linked', ...extra, '--file', file], ctx.databaseRoot)
    await nonempty(file)
  }
  await saveJson(localFile(ctx, 'frontend-before.json'), frontend)
  await saveJson(localFile(ctx, 'edge-before.json'), edge)
  await writeFile(localFile(ctx, 'recovery.sql'), await readFile(ctx.config.recoverySql), { mode: 0o600 })
  const previousRoot = localFile(ctx, 'previous-edge')
  await archive(ctx, edge.commitSha, previousRoot)
  const previous = await stamp(ctx, previousRoot, edge.commitSha)
  requireValue(previous.edgeArtifactDigest === edge.edgeArtifactDigest, 'Previous Edge source does not reproduce the deployed artifact')
  const previousConfig = await readFile(path.join(previousRoot, 'supabase/config.toml'), 'utf8')
  const previousFunctions = functions.filter(name => configuredFunctions(previousConfig).includes(name))
  const files = Object.fromEntries(Object.entries(await hashTree(previousRoot)).map(([name, hash]) => [`previous-edge/${name}`, hash]))
  for (const name of ['schema.sql', 'data.sql', 'migration-list.json', 'frontend-before.json', 'edge-before.json', 'recovery.sql']) {
    files[name] = sha256(await readFile(localFile(ctx, name)))
  }
  return { frontend, edge, functions, previousFunctions, files, migrations: migrations.map(row => row.version) }
}

export async function verifyBackup(ctx) {
  await verifyFiles(ctx.directory, resultOf(ctx, 'backup').files)
}

async function deploy(ctx, root, functions) {
  if (ctx.dryRun) {
    for (const name of functions) {
      await nonempty(path.join(root, `supabase/functions/${name}/index.ts`))
      await ctx.run('deno', ['check', '--no-lock', '--node-modules-dir=none', path.join(root, `supabase/functions/${name}/index.ts`)], root)
    }
  } else {
    for (const name of functions) await ctx.run('supabase', ['functions', 'deploy', name, '--project-ref', ctx.config.projectRef, '--use-api'], root)
  }
}

export async function edgeDeploy(ctx) {
  await verifyBackup(ctx)
  await checkSource(ctx)
  const root = localFile(ctx, 'candidate-edge')
  await archive(ctx, ctx.candidate, root)
  const identity = await stamp(ctx, root, ctx.candidate)
  await deploy(ctx, root, resultOf(ctx, 'backup').functions)
  await marker(ctx, edgeMarker(ctx), 'Edge', ctx.candidate, identity.edgeArtifactDigest)
  return identity
}

async function migrations(ctx) {
  return (await readdir(path.join(ctx.root, 'supabase/migrations'))).filter(file => /^\d+_.+\.sql$/.test(file)).sort()
}

export async function databasePlan(ctx) {
  await checkSource(ctx)
  const rows = await sql(ctx, migrationQuery)
  const files = await migrations(ctx)
  const versions = files.map(file => file.split('_')[0])
  requireValue(rows.every(row => versions.includes(row.version)), 'Database history includes migrations absent from the candidate')
  const pending = files.filter(file => !rows.some(row => row.version === file.split('_')[0]))
  const { stdout, stderr } = await ctx.run('supabase', ['db', 'push', ctx.dryRun ? '--local' : '--linked', '--dry-run'], ctx.databaseRoot)
  const output = `${stdout}\n${stderr}`
  await writeFile(localFile(ctx, 'db-push-dry-run.txt'), output, { mode: 0o600 })
  const listed = [...new Set(output.match(/\b\d{14}_[\w-]+\.sql\b/g) ?? [])].sort()
  requireValue(JSON.stringify(listed) === JSON.stringify(pending), 'Database dry-run migration list differs from the expected plan')
  return { pending, versions }
}

export async function databasePush(ctx) {
  await verifyBackup(ctx)
  const plan = await databasePlan(ctx)
  const approved = resultOf(ctx, 'db-dry-run')
  requireValue(plan.pending.every(file => approved.pending.includes(file)), 'Migration plan changed after approval')
  if (!ctx.dryRun) await ctx.run('supabase', ['db', 'push', '--linked', '--yes'], ctx.databaseRoot)
  const versions = (await sql(ctx, migrationQuery)).map(row => row.version)
  const expected = ctx.dryRun ? approved.versions.filter(version => !approved.pending.some(file => file.startsWith(`${version}_`))) : approved.versions
  requireValue(JSON.stringify(versions) === JSON.stringify(expected), 'Database history differs after push')
  return { applied: !ctx.dryRun, pending: plan.pending, versions }
}

async function pullRequest(ctx) {
  if (ctx.dryRun) return readJson(ctx.config.pullRequestReceipt)
  return JSON.parse((await ctx.run('gh', ['pr', 'view', String(ctx.config.pr), '--json', 'state,baseRefName,baseRefOid,headRefOid,mergeCommit'], ctx.root)).stdout)
}

export function validatePullRequest(pr, candidate, expectedMain) {
  requireValue(pr.headRefOid === candidate && pr.baseRefName === 'main', 'Pull request does not match candidate/main')
  requireValue(pr.state === 'OPEN' || (pr.state === 'MERGED' && fullSha(pr.mergeCommit?.oid)), 'Pull request is not open or merged')
  if (pr.state === 'OPEN') requireValue(pr.baseRefOid === expectedMain, 'Pull request base changed')
}

async function verifyMerge(ctx, sha) {
  const commit = JSON.parse((await ctx.run('gh', ['api', `repos/{owner}/{repo}/git/commits/${sha}`], ctx.root)).stdout)
  const tree = await git(ctx, ['rev-parse', `${ctx.candidate}^{tree}`])
  requireValue(commit.sha === sha && commit.parents?.length === 1 && commit.parents[0].sha === ctx.config.expectedMain && commit.tree?.sha === tree, 'Squash commit does not match the approved base and candidate tree')
}

export async function merge(ctx) {
  const before = await pullRequest(ctx)
  validatePullRequest(before, ctx.candidate, ctx.config.expectedMain)
  if (ctx.dryRun) {
    requireValue(before.state === 'OPEN', 'Dry-run pull request fixture must be open')
    await checkSource(ctx)
    return { squashSha: ctx.candidate, simulated: true, releaseNotesSha256: sha256(await readFile(ctx.config.releaseNotes)) }
  }
  if (before.state === 'OPEN') {
    await checkSource(ctx)
    await ctx.run('gh', ['pr', 'merge', String(ctx.config.pr), '--squash', '--match-head-commit', ctx.candidate, '--body-file', ctx.config.releaseNotes], ctx.root)
  }
  const after = await pullRequest(ctx)
  validatePullRequest(after, ctx.candidate, ctx.config.expectedMain)
  requireValue(after.state === 'MERGED', 'Pull request has not merged')
  await verifyMerge(ctx, after.mergeCommit.oid)
  return { squashSha: after.mergeCommit.oid, simulated: false, releaseNotesSha256: sha256(await readFile(ctx.config.releaseNotes)) }
}

export async function waitFrontend(ctx) {
  const expected = resultOf(ctx, 'merge').squashSha
  const end = Date.now() + (ctx.config.waitSeconds ?? 600) * 1000
  let lastError
  do {
    try {
      const value = await marker(ctx, frontendMarker(ctx), 'Frontend', expected, ctx.config.expectedBundleDigest)
      return { commitSha: value.commitSha, bundleDigest: value.bundleDigest }
    } catch (error) { lastError = error }
    if (ctx.dryRun) break
    console.log('Waiting for the frontend release identity')
    await ctx.sleep(5000)
  } while (Date.now() < end)
  throw lastError
}

export async function verifyFrontend(ctx) {
  const expected = resultOf(ctx, 'wait-vercel')
  const value = await marker(ctx, frontendMarker(ctx), 'Frontend', expected.commitSha, expected.bundleDigest)
  requireValue(digest(value.bundleDigest), 'Frontend digest is invalid')
  return { commitSha: value.commitSha, bundleDigest: value.bundleDigest }
}

export async function restamp(ctx) {
  await verifyBackup(ctx)
  const root = localFile(ctx, 'candidate-edge')
  await archive(ctx, ctx.candidate, root)
  const identity = await stamp(ctx, root, resultOf(ctx, 'merge').squashSha)
  requireValue(identity.edgeArtifactDigest === resultOf(ctx, 'edge-deploy').edgeArtifactDigest, 'Restamping changes the Edge artifact digest')
  await deploy(ctx, root, resultOf(ctx, 'backup').functions)
  await marker(ctx, edgeMarker(ctx), 'Edge', identity.commitSha, identity.edgeArtifactDigest)
  return { ...identity, simulated: ctx.dryRun }
}

export async function smoke(ctx) {
  await verifyFrontend(ctx)
  const identity = resultOf(ctx, 'edge-restamp')
  await marker(ctx, edgeMarker(ctx), 'Edge', identity.commitSha, identity.edgeArtifactDigest)
  const response = await checkedFetch(ctx, new URL(`/_expo/static/js/web/release-missing-${ctx.candidate}.js`, ctx.config.frontendUrl))
  requireValue(response.status === 404 && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? ''), 'Missing chunk must return 404 no-store')
  const rows = await sql(ctx, invocationQuery)
  requireValue(rows.length === 1 && Number(rows[0].errors) === 0, 'Edge invocation errors exist in the last 15 minutes')
  return { health: true, missingChunk: '404 no-store', invocationErrors: 0, checkedAt: new Date().toISOString() }
}

export async function rollback(ctx) {
  requireValue(resultOf(ctx, 'backup'), 'Rollback requires a completed backup')
  await verifyBackup(ctx)
  const backup = resultOf(ctx, 'backup')
  await deploy(ctx, localFile(ctx, 'previous-edge'), backup.previousFunctions)
  if (!ctx.dryRun) await marker(ctx, edgeMarker(ctx), 'Edge', backup.edge.commitSha, backup.edge.edgeArtifactDigest)
  return { previousEdge: backup.edge, retainedNewFunctions: backup.functions.filter(name => !backup.previousFunctions.includes(name)), recoverySql: localFile(ctx, 'recovery.sql'), simulated: ctx.dryRun }
}

export async function verifyProgress(ctx, name, result) {
  if (name === 'edge-deploy') {
    const identity = resultOf(ctx, 'edge-restamp') ?? result
    await marker(ctx, edgeMarker(ctx), 'Edge', identity.commitSha, identity.edgeArtifactDigest)
  }
  if (name === 'db-push') {
    const versions = (await sql(ctx, migrationQuery)).map(row => row.version)
    requireValue(JSON.stringify(versions) === JSON.stringify(result.versions), 'Database history changed since the completed push')
  }
  if (name === 'merge' && !ctx.dryRun) {
    const pr = await pullRequest(ctx)
    validatePullRequest(pr, ctx.candidate, ctx.config.expectedMain)
    requireValue(pr.state === 'MERGED' && pr.mergeCommit.oid === result.squashSha, 'Saved squash merge differs from the pull request')
    await verifyMerge(ctx, result.squashSha)
  }
  if (name === 'wait-vercel' || name === 'verify-provenance') {
    await marker(ctx, frontendMarker(ctx), 'Frontend', result.commitSha, result.bundleDigest)
  }
}

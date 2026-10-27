import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fullSha, readJson, requireValue, sha256 } from './runtime.mjs'

const REQUIRED_CHECKS = ['npm run check:comprehensive', 'npm test']

export async function checkSource(ctx, remote = true) {
  const git = async args => (await ctx.run('git', args, ctx.root)).stdout.trim()
  requireValue(await git(['rev-parse', 'HEAD']) === ctx.candidate, 'HEAD differs from the candidate')
  const branch = await git(['branch', '--show-current'])
  requireValue(branch !== 'main' && (ctx.dryRun || branch.length > 0), 'Release requires a candidate branch')
  requireValue(await git(['merge-base', 'origin/main', 'HEAD']) === ctx.config.expectedMain, 'Candidate must include origin/main')
  requireValue(await git(['status', '--porcelain', '--untracked-files=all']) === '', 'Candidate branch is dirty')
  requireValue(await git(['rev-parse', 'origin/main']) === ctx.config.expectedMain, 'origin/main changed')
  if (!ctx.dryRun && remote) {
    const remote = (await git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main'])).split(/\s+/)[0]
    requireValue(remote === ctx.config.expectedMain, 'Remote main changed')
  }
}

export function validateReplay(receipt, candidate) {
  requireValue((receipt.source?.application?.commit ?? receipt.candidate) === candidate && (receipt.candidate === undefined || receipt.candidate === candidate), 'Replay receipt belongs to another candidate')
  requireValue(receipt.passed === true && receipt.complete === true && receipt.invariantFailures === 0, 'Replay receipt is not passing')
  requireValue(!receipt.failure && !receipt.error && !receipt.cleanupError && (receipt.failures ?? []).length === 0, 'Replay receipt contains failures')
  requireValue(receipt.fullAcceptance === true || (receipt.lateStart?.passed === true && Array.isArray(receipt.lateStart.gaps) && receipt.lateStart.gaps.length === 0), 'Replay receipt lacks acceptance')
}

export async function preflight(ctx, remote = true) {
  await checkSource(ctx, remote)
  const { config } = ctx
  validateReplay(await readJson(config.replayReceipt), ctx.candidate)
  const checks = await readJson(config.checksReceipt)
  requireValue(checks.candidate === ctx.candidate && checks.passed === true, 'Local checks do not match the candidate')
  requireValue(Array.isArray(checks.commands) && checks.commands.every(row => row.exitCode === 0), 'Local checks contain failures')
  for (const required of REQUIRED_CHECKS) {
    const check = checks.commands?.find(row => row.command === required)
    requireValue(check?.exitCode === 0 && typeof check.log === 'string', `Missing green check: ${required}`)
    requireValue(sha256(await readFile(path.resolve(path.dirname(config.checksReceipt), check.log))) === check.sha256, `Check log changed: ${required}`)
  }
  requireValue((await readFile(config.releaseNotes, 'utf8')).trim().length > 0, 'Release notes are empty')
  requireValue((await readFile(config.recoverySql, 'utf8')).trim().length > 0, 'Recovery SQL is empty')
  if (ctx.dryRun) {
    const stack = await readFile(path.join(ctx.databaseRoot, 'supabase/config.toml'), 'utf8')
    requireValue(/^project_id\s*=\s*"pt4bafablerelease"$/m.test(stack), 'Dry runs require the private release stack')
    const migrations = (await ctx.run('git', ['ls-files', 'supabase/migrations'], ctx.root)).stdout.trim().split('\n').filter(Boolean)
    for (const file of migrations) requireValue(sha256(await readFile(path.join(ctx.root, file))) === sha256(await readFile(path.join(ctx.databaseRoot, file))), 'Private stack migrations differ from candidate')
    for (const match of stack.matchAll(/^\s*(?:port|shadow_port|inspector_port|smtp_port|pop3_port)\s*=\s*(\d+)/gm)) {
      requireValue(Number(match[1]) >= 59400 && Number(match[1]) <= 59499, 'Dry-run stack ports must use 594xx')
    }
  } else {
    requireValue((await readFile(path.join(ctx.databaseRoot, 'supabase/.temp/project-ref'), 'utf8')).trim() === config.projectRef, 'Linked Supabase project differs')
    await ctx.run('gh', ['auth', 'status'], ctx.root)
    await ctx.run('supabase', ['projects', 'list', '-o', 'json'], ctx.root)
  }
  requireValue(fullSha(ctx.candidate), 'Candidate must be a full SHA')
  return { candidate: ctx.candidate, expectedMain: config.expectedMain, checkedAt: new Date().toISOString() }
}

import process from 'node:process'
import { recoverReleaseArtifact } from './release-artifact.mjs'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} is required`)
  return args[index + 1]
}
try {
  const result = await recoverReleaseArtifact({
    url: option('--url'), root: option('--output'),
    expectedCommitSha: option('--expected-sha'), expectedBundleDigest: option('--expected-digest'),
  })
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

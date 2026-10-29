import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { regenerateAttestation, regenerateSecurityCatalog } from '../regenerate-release-history-attestations.mjs'
import { digest, sourceRoot } from './common.mjs'

export async function regenerate(evidence) {
  const files = await Promise.all((await readdir(path.join(sourceRoot, 'supabase/migrations')))
    .filter(file => /^\d+_.+\.sql$/.test(file)).sort().map(async filename => {
      const sql = await readFile(path.join(sourceRoot, 'supabase/migrations', filename), 'utf8')
      return { filename, sql, sha256: digest(sql) }
    }))
  const history = JSON.parse(await readFile(path.join(evidence, 'migration-history.json'), 'utf8'))
  const catalog = JSON.parse(await readFile(path.join(evidence, 'security-catalog.json'), 'utf8'))
  const read = async file => JSON.parse(await readFile(path.join(sourceRoot, file), 'utf8'))
  const first = 'tests/e2e/release-history-attestations.json'
  const second = 'tests/e2e/db-security-catalog-attestations.json'
  await writeFile(path.join(sourceRoot, first), `${JSON.stringify(regenerateAttestation(await read(first), files, history), null, 2)}\n`)
  await writeFile(path.join(sourceRoot, second), `${JSON.stringify(regenerateSecurityCatalog(await read(second), files, catalog), null, 2)}\n`)
  return files.length
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await regenerate(process.argv[2]))

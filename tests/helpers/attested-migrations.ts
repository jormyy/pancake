import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const attestation = JSON.parse(readFileSync('tests/e2e/release-history-attestations.json', 'utf8'))
const auditedHead: string = attestation.approvedMigrations.at(-1)?.version ?? attestation.baselineVersion

// Historical release fixtures stop at their recorded approval. Runtime guards
// still receive every repository migration and reject any unapproved suffix.
export const attestedMigrationFiles = readdirSync('supabase/migrations')
  .filter((filename) => filename.endsWith('.sql') && filename.split('_')[0] <= auditedHead)
  .sort()
  .map((filename) => ({
    filename,
    sha256: createHash('sha256').update(readFileSync(path.join('supabase/migrations', filename))).digest('hex'),
  }))

export function copyAttestedMigrations(root: string): void {
  const target = path.join(root, 'supabase/migrations')
  mkdirSync(target, { recursive: true })
  for (const { filename } of attestedMigrationFiles) {
    copyFileSync(path.join('supabase/migrations', filename), path.join(target, filename))
  }
}

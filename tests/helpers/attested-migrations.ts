import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const attestation = JSON.parse(readFileSync('tests/e2e/release-history-attestations.json', 'utf8'))
export const attestedMigrationFiles = readdirSync('supabase/migrations')
  .filter((filename) => filename.endsWith('.sql'))
  .sort()
  .map((filename) => ({
    filename,
    sha256: createHash('sha256').update(readFileSync(path.join('supabase/migrations', filename))).digest('hex'),
  }))

type ConvergedHelper = { name: string, identityArguments: string, bodySha256: string } & Record<string, unknown>
type Redefinition = ConvergedHelper & { version: string }

// The converged helper definitions a database shows after exactly these applied versions:
// each approved redefinition counts only once its own migration has been applied.
export function convergenceAfter(appliedVersions: Iterable<string>): ConvergedHelper[] {
  const applied = new Set(appliedVersions)
  const redefinitions: Redefinition[] = attestation.convergenceRedefinitions ?? []
  return attestation.convergence.map((helper: ConvergedHelper) => {
    const latest = redefinitions.filter((row) => row.name === helper.name &&
      row.identityArguments === helper.identityArguments && applied.has(row.version)).at(-1)
    return latest ? { ...structuredClone(helper), bodySha256: latest.bodySha256 } : structuredClone(helper)
  })
}

export function copyAttestedMigrations(root: string): void {
  const target = path.join(root, 'supabase/migrations')
  mkdirSync(target, { recursive: true })
  for (const { filename } of attestedMigrationFiles) {
    copyFileSync(path.join('supabase/migrations', filename), path.join(target, filename))
  }
}

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { functionDefinitionsInSource } from './check-db-function-sources.mjs'
import { databaseTarget } from './mutation/waivers/targets.mjs'

const attestationFile = 'tests/e2e/release-history-attestations.json'
const securityFile = 'tests/e2e/db-security-catalog-attestations.json'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export const migrationSqlFingerprint = (sql) => {
  const tokens = []
  for (let index = 0; index < sql.length;) {
    if (/\s|;/.test(sql[index])) {
      index++
    } else if (sql.startsWith('--', index)) {
      while (index < sql.length && sql[index] !== '\n') index++
    } else if (sql.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { depth++; index += 2 }
        else if (sql.startsWith('*/', index)) { depth--; index += 2 }
        else index++
      }
      if (depth) throw new Error('Unterminated migration comment')
    } else if (sql[index] === "'" || sql[index] === '"') {
      const start = index
      const quote = sql[index++]
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) index += 2
        else if (sql[index++] === quote) break
      }
      tokens.push(sql.slice(start, index))
    } else {
      const delimiter = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index))?.[0]
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length)
        if (end < 0) throw new Error('Unterminated migration body')
        tokens.push(sql.slice(index, end + delimiter.length))
        index = end + delimiter.length
      } else {
        const token = /^[A-Za-z0-9_$]+/.exec(sql.slice(index))?.[0] ?? sql[index]
        tokens.push(token)
        index += token.length
      }
    }
  }
  return sha256(tokens.join('\0'))
}

export const attestationRangeFailures = (attestation, files) => {
  const failures = []
  if (files.length !== attestation.baselineCount + attestation.approvedMigrations.length ||
      files.at(-1)?.filename.split('_')[0] !== (attestation.approvedMigrations.at(-1)?.version ?? attestation.baselineVersion)) {
    failures.push('Attested migration range must end at the repository migration head')
  }
  for (const [index, approved] of attestation.approvedMigrations.entries()) {
    const file = files[attestation.baselineCount + index]
    if (file?.filename !== `${approved.version}_${approved.name}.sql` || file.sha256 !== approved.sha256) {
      failures.push(`Attested migration SQL differs at ${approved.version}`)
    }
  }
  return failures
}

export const regenerateAttestation = (attestation, files, snapshot) => {
  if (!Array.isArray(snapshot?.history) || snapshot.history.length !== files.length ||
      !Array.isArray(snapshot.functions) || snapshot.oldHelperCount !== 0 || snapshot.oldHelperReferenceCount !== 0) {
    throw new Error('Local stack must contain every repository migration and converged helpers')
  }
  const next = structuredClone(attestation)
  next.approvedMigrations = files.slice(attestation.baselineCount).map((file, index) => {
    const row = snapshot.history[attestation.baselineCount + index]
    const version = file.filename.split('_')[0]
    const name = file.filename.slice(version.length + 1, -4)
    if (row.version !== version || row.name !== name || !Number.isInteger(row.statementCount) ||
        row.statementCount < 1 || !/^[a-f0-9]{64}$/.test(row.statementsSha256 ?? '')) {
      throw new Error(`Local migration history does not match ${file.filename}`)
    }
    const previous = attestation.approvedMigrations.find((entry) => entry.version === version) ?? {}
    return { ...previous, name, version, statementCount: row.statementCount, statementsSha256: row.statementsSha256, sha256: file.sha256 }
  })
  for (const [index, file] of files.entries()) {
    const row = snapshot.history[index]
    if (row.version !== file.filename.split('_')[0]) {
      throw new Error(`Local migration history diverges at ${file.filename}`)
    }
    if (!Array.isArray(row.statements) || migrationSqlFingerprint(row.statements.join(';\n')) !== migrationSqlFingerprint(file.sql)) {
      throw new Error(`Local migration SQL differs from ${file.filename}; reset the private stack first`)
    }
  }
  if (files[attestation.baselineCount - 1]?.filename.split('_')[0] !== attestation.baselineVersion) {
    throw new Error('Local migration baseline differs from the recorded audit')
  }
  next.convergenceRedefinitions = []
  for (const file of files.slice(attestation.baselineCount)) {
    const version = file.filename.split('_')[0]
    const definitions = functionDefinitionsInSource(file.sql)
    for (const helper of next.convergence) {
      const definition = definitions.get(`public.${helper.name}`)
      if (!definition) continue
      const delimiter = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(definition)
      if (!delimiter) throw new Error(`Cannot read converged helper body in ${file.filename}`)
      const start = delimiter.index + delimiter[0].length
      const end = definition.indexOf(delimiter[1], start)
      if (end < 0) throw new Error(`Cannot read converged helper terminator in ${file.filename}`)
      const bodySha256 = sha256(definition.slice(start, end))
      const previous = next.convergenceRedefinitions.filter((row) => row.name === helper.name &&
        row.identityArguments === helper.identityArguments).at(-1) ?? helper
      if (previous.bodySha256 !== bodySha256) {
        const recorded = attestation.convergenceRedefinitions.find((row) => row.version === version && row.name === helper.name &&
          row.identityArguments === helper.identityArguments) ?? {}
        next.convergenceRedefinitions.push({ ...recorded, version, name: helper.name, identityArguments: helper.identityArguments, bodySha256 })
      }
    }
  }
  if (snapshot.functions.length !== next.convergence.length) throw new Error('Local converged helper inventory differs from the recorded audit')
  for (const [index, helper] of next.convergence.entries()) {
    const latest = next.convergenceRedefinitions.filter((row) => row.name === helper.name &&
      row.identityArguments === helper.identityArguments).at(-1)
    const expected = latest ? { ...helper, bodySha256: latest.bodySha256 } : helper
    if (Object.entries(expected).some(([key, value]) => JSON.stringify(snapshot.functions[index]?.[key]) !== JSON.stringify(value))) {
      throw new Error(`Local helper does not match its migration definitions: ${helper.name}`)
    }
  }
  return next
}

export const regenerateSecurityCatalog = (contract, files, catalog) => {
  if (catalog.replicationRole !== 'origin' || catalog.serviceRoleMissingReads !== 0) {
    throw new Error('Local catalog requires origin triggers and service-role reads')
  }
  const deployedBaselineVersion = contract.preMigration.version
  const count = files.findIndex((file) => file.filename.split('_')[0] === deployedBaselineVersion) + 1
  if (!count || count >= files.length) throw new Error('Deployed security baseline must precede the release head')
  const next = structuredClone(contract)
  next.candidateVersion = files.at(-1).filename.split('_')[0]
  next.preMigration = { count, version: deployedBaselineVersion }
  for (const section of ['functions', 'triggers', 'policies', 'tables', 'indexes']) {
    const before = [...contract.common[section], ...contract.phases['pre-migration'][section]]
    const after = catalog[section]
    if (!Array.isArray(after)) throw new Error(`Local security catalog is missing ${section}`)
    next.common[section] = before.filter((row) => after.some((other) => isDeepStrictEqual(row, other)))
    next.phases['pre-migration'][section] = before.filter((row) => !next.common[section].includes(row))
    next.phases['post-migration'][section] = after.filter((row) => !next.common[section].some((other) => isDeepStrictEqual(row, other)))
  }
  const sources = new Set([...contract.sourceMigrations.map((row) => row.filename), ...files.slice(count).map((row) => row.filename)])
  next.sourceMigrations = files.filter((file) => sources.has(file.filename)).map(({ filename, sha256 }) => ({ filename, sha256 }))
  return next
}

const main = () => {
  const attestation = JSON.parse(readFileSync(attestationFile, 'utf8'))
  const files = readdirSync('supabase/migrations').filter((file) => /^\d+_.+\.sql$/.test(file)).sort().map((filename) => {
    const sql = readFileSync(path.join('supabase/migrations', filename), 'utf8')
    return { filename, sql, sha256: sha256(sql) }
  })
  if (process.argv.includes('--check')) {
    const failures = attestationRangeFailures(attestation, files)
    const security = JSON.parse(readFileSync(securityFile, 'utf8'))
    if (security.candidateVersion !== files.at(-1).filename.split('_')[0]) failures.push('Security catalog attestation must end at the repository migration head')
    for (const source of security.sourceMigrations) {
      if (files.find((row) => row.filename === source.filename)?.sha256 !== source.sha256) failures.push(`Security catalog source differs at ${source.filename}`)
    }
    if (failures.length) throw new Error(failures.join('; '))
  } else {
    const target = databaseTarget()
    const query = readFileSync('tests/e2e/release-schema-history.sql', 'utf8')
      .replace("'statementCount', cardinality(m.statements),", "'statements', m.statements, 'statementCount', cardinality(m.statements),")
    const output = execFileSync('psql', [target.href, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      input: query, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const next = regenerateAttestation(attestation, files, JSON.parse(output.trim()))
    const catalogOutput = execFileSync('psql', [target.href, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/e2e/db-security-catalog.sql'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const security = regenerateSecurityCatalog(JSON.parse(readFileSync(securityFile, 'utf8')), files, JSON.parse(catalogOutput.trim()))
    writeFileSync(attestationFile, `${JSON.stringify(next, null, 2)}\n`)
    writeFileSync(securityFile, `${JSON.stringify(security, null, 2)}\n`)
  }
  console.log(`Release migration attestations cover ${files.length} migrations through ${files.at(-1).filename.split('_')[0]}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

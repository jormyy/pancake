import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_ROOT = process.cwd()
const REPORT_PATH = path.join(DEFAULT_ROOT, 'tests/local-secret-scan-report.md')
const SKIP_DIRS = new Set(['.git', 'node_modules', 'ios', 'android', '.expo', 'dist', 'web-build'])
const ENV_FILE = /^\.env(?:[.-].*)?$/
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

const decodeBase64UrlJson = (value) => {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
  const json = Buffer.from(padded.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')
  return JSON.parse(json)
}

const jwtPayload = (value) => {
  const trimmed = value.trim()
  if (!JWT.test(trimmed)) return null
  const parts = trimmed.split('.')
  try {
    return decodeBase64UrlJson(parts[1])
  } catch {
    return null
  }
}

const isActiveServiceRoleJwt = (payload) => {
  if (!payload || payload.role !== 'service_role') return false
  return typeof payload.exp !== 'number' || payload.exp > Date.now() / 1000
}

const envFiles = (dir, depth = 0) => {
  if (depth > 5) return []
  const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []
  const files = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...envFiles(path.join(dir, entry.name), depth + 1))
      continue
    }
    if (entry.isFile() && ENV_FILE.test(entry.name)) files.push(path.join(dir, entry.name))
  }

  return files
}

const parseEnvLine = (line) => {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (!match) return null
  let value = match[2].trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return { name: match[1], value }
}

export const scanLocalSecrets = (root = DEFAULT_ROOT) => {
  const findings = []

  for (const file of envFiles(root).sort()) {
    const relative = path.relative(root, file)
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const parsed = parseEnvLine(line)
      if (!parsed || !parsed.value) return

      const payload = jwtPayload(parsed.value)
      if (isActiveServiceRoleJwt(payload)) {
        const expiry = typeof payload.exp === 'number'
          ? new Date(payload.exp * 1000).toISOString()
          : 'missing'
        findings.push({
          file: relative,
          line: index + 1,
          name: parsed.name,
          reason: `active Supabase service-role JWT (exp=${expiry})`,
        })
        return
      }

      if (/(^|_)SUPABASE_SERVICE_ROLE_KEY$/.test(parsed.name)) {
        findings.push({
          file: relative,
          line: index + 1,
          name: parsed.name,
          reason: 'legacy service-role env variable is not allowed in local env files',
        })
      }
    })
  }

  return findings
}

const writeReport = async (findings) => {
  const lines = [
    '# Local Secret Scan',
    '',
    `- Status: ${findings.length === 0 ? 'PASS' : 'BLOCKED'}`,
    `- Generated: ${new Date().toISOString()}`,
    '',
    '| File | Variable | Status | Evidence |',
    '| --- | --- | --- | --- |',
    ...(findings.length === 0
      ? [['local env files', 'service-role JWTs', 'PASS', 'No active service-role JWTs or legacy service-role env variables found.']]
      : findings.map((finding) => [
        `${finding.file}:${finding.line}`,
        finding.name,
        'BLOCKED',
        finding.reason,
      ])).map((row) => `| ${row.join(' | ')} |`),
    '',
  ]

  await writeFile(REPORT_PATH, `${lines.join('\n')}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const findings = scanLocalSecrets()
  await writeReport(findings)
  console.log(`${findings.length === 0 ? 'PASS' : 'BLOCKED'} ${REPORT_PATH}`)
  if (findings.length > 0) process.exitCode = 1
}

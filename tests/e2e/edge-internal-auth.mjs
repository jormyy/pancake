import path from 'node:path'
import process from 'node:process'
import {
  cleanMessage,
  envValue,
  localSupabaseStatus,
  writeMarkdownReport,
} from './env.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/edge-internal-auth-report.md')

const targetConfig = (target) => {
  if (target === 'local') {
    const status = localSupabaseStatus()
    return {
      apiUrl: status.API_URL,
      publicKeys: [status.PUBLISHABLE_KEY, status.ANON_KEY].filter(Boolean),
    }
  }

  return {
    apiUrl: envValue('E2E_SUPABASE_URL', 'SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL'),
    publicKeys: [
      envValue('E2E_SUPABASE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    ].filter(Boolean),
  }
}

const args = new Set(process.argv.slice(2))
const targets = args.has('--both')
  ? ['local', 'linked']
  : [args.has('--linked') ? 'linked' : 'local']
const positive = args.has('--positive')
const functionNames = ['verify']

const unique = (values) => [...new Set(values.filter(Boolean))]
const isAuthFailure = (status) => status === 401 || status === 403

const probe = async (apiUrl, functionName, headers) => {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: '__edge_auth_probe__' }),
  })

  return { status: res.status, text: await res.text().catch(() => '') }
}

const rows = []
const addRow = (target, requirement, status, evidence) => rows.push({ target, requirement, status, evidence })

for (const target of targets) {
  try {
    const { apiUrl, publicKeys } = targetConfig(target)
    if (!apiUrl) throw new Error(`${target} Supabase API URL is unavailable`)
    const keys = unique(publicKeys)
    if (keys.length === 0) throw new Error(`${target} public Supabase key is unavailable`)

    for (const functionName of functionNames) {
      for (const [index, key] of keys.entries()) {
        const result = await probe(apiUrl, functionName, {
          apikey: key,
          Authorization: `Bearer ${key}`,
        })
        addRow(
          target,
          `${functionName} rejects public key ${index + 1} as internal auth`,
          isAuthFailure(result.status) ? 'PASS' : 'BLOCKED',
          `HTTP ${result.status}; ${cleanMessage(result.text)}`,
        )
      }
    }

    if (positive) {
      const internalToken = envValue('PANCAKE_EDGE_INTERNAL_TOKEN', 'EDGE_FUNCTION_INTERNAL_TOKEN')
      if (!internalToken) throw new Error('PANCAKE_EDGE_INTERNAL_TOKEN or EDGE_FUNCTION_INTERNAL_TOKEN is required for --positive')
      const result = await probe(apiUrl, 'verify', {
        apikey: keys[0],
        'x-internal-function-token': internalToken,
      })
      addRow(
        target,
        'verify accepts dedicated internal token header',
        isAuthFailure(result.status) || result.status >= 500 ? 'BLOCKED' : 'PASS',
        `HTTP ${result.status}; ${cleanMessage(result.text)}`,
      )
    }
  } catch (error) {
    addRow(target, 'Edge internal auth probe', 'BLOCKED', error instanceof Error ? error.message : String(error))
  }
}

const blockers = rows.filter((row) => row.status !== 'PASS')
await writeMarkdownReport({
  reportPath: REPORT_PATH,
  title: 'Edge Internal Auth',
  rows,
  columns: [
    { header: 'Target', value: (row) => row.target },
    { header: 'Requirement', value: (row) => row.requirement },
    { header: 'Status', value: (row) => row.status },
    { header: 'Evidence', value: (row) => row.evidence },
  ],
})
console.log(`${blockers.length === 0 ? 'PASS' : 'BLOCKED'} ${REPORT_PATH}`)
if (blockers.length > 0) process.exitCode = 1

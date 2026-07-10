import process from 'node:process'
import { validateProductionBackendIdentity } from './production-readiness-contract.mjs'

const failures = validateProductionBackendIdentity({
  expectedProjectRef: process.env.E2E_PRODUCTION_SUPABASE_REF ?? '',
  linkedProjectRef: process.env.SUPABASE_PROJECT_REF ?? '',
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  edgeApiUrl: process.env.EXPO_PUBLIC_API_URL ?? '',
})

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log('PASS protected production backend identity')

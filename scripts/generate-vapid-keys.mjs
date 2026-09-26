// Generates a VAPID key pair for standards Web Push (PWA notifications).
// Store both values as Supabase Edge secrets; never commit the private key.
//   node scripts/generate-vapid-keys.mjs
import { webcrypto } from 'node:crypto'

const base64Url = (bytes) => Buffer.from(bytes).toString('base64url')

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const publicKey = base64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)))
const { d: privateKey } = await webcrypto.subtle.exportKey('jwk', pair.privateKey)

console.log(`WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}`)
console.log('WEB_PUSH_VAPID_SUBJECT=mailto:you@example.com')
// Run from outside the repo: inside it, `secrets set` also uploads
// supabase/config.toml [edge_runtime.secrets] (local-only values) to production.
console.log('\nSet them from outside the repo (check the reported count is 3):')
console.log('  cd /tmp && supabase secrets set --project-ref <ref> WEB_PUSH_VAPID_PUBLIC_KEY=... WEB_PUSH_VAPID_PRIVATE_KEY=... WEB_PUSH_VAPID_SUBJECT=...')

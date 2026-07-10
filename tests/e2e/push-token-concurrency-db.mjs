import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv } from './env.mjs'

const ITERATIONS = 12
const PASSWORD = 'PancakePushConcurrency!2026'

const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey'])
const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
const createdUserIds = []

async function createUser(label) {
  const email = `pancake-push-concurrency-${Date.now()}-${label}@example.test`
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { username: `push_concurrency_${label}_${Date.now()}`.slice(0, 30) },
  })
  if (error || !data.user) throw error ?? new Error(`Could not create ${label} push concurrency user`)
  createdUserIds.push(data.user.id)
  return data.user.id
}

async function register(userId, token, hash) {
  const { error } = await admin.rpc('register_push_token_atomic', {
    p_user_id: userId,
    p_token: token,
    p_revocation_hash: hash,
  })
  if (error) throw error
}

try {
  const [firstUserId, secondUserId] = await Promise.all([createUser('a'), createUser('b')])

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const token = `ExponentPushToken[concurrent-transfer-${Date.now()}-${iteration}]`
    const hashes = new Map([
      [firstUserId, `a${iteration.toString(16).padStart(63, '0')}`],
      [secondUserId, `b${iteration.toString(16).padStart(63, '0')}`],
    ])
    await Promise.all([
      register(firstUserId, token, hashes.get(firstUserId)),
      register(secondUserId, token, hashes.get(secondUserId)),
    ])

    const { data, error } = await admin
      .from('profiles')
      .select('id, push_token, push_token_revocation_hash')
      .in('id', [firstUserId, secondUserId])
    if (error) throw error
    const owners = (data ?? []).filter((profile) => profile.push_token === token)
    assert.equal(owners.length, 1, `iteration ${iteration} did not converge to exactly one token owner`)
    assert.equal(
      owners[0].push_token_revocation_hash,
      hashes.get(owners[0].id),
      `iteration ${iteration} retained a credential from the losing owner`,
    )
    const loser = (data ?? []).find((profile) => profile.id !== owners[0].id)
    assert.equal(loser?.push_token, null, `iteration ${iteration} retained the losing owner token`)
    assert.equal(loser?.push_token_revocation_hash, null, `iteration ${iteration} retained the losing credential`)
  }

  console.log(`PASS push token concurrency: ${ITERATIONS} atomic ownership transfers`)
} finally {
  const cleanupErrors = []
  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (error) cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Push concurrency cleanup failed')
}

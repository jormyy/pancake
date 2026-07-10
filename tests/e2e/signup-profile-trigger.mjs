import process from 'node:process'

const requiredEnv = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const jsonResponse = async (response, label) => {
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`)
  }
  return body
}

export async function runSignupProfileTriggerProbe({
  apiUrl = requiredEnv('SUPABASE_URL'),
  anonKey = requiredEnv('SUPABASE_ANON_KEY'),
  serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
} = {}) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100_000)}`
  const email = `triggerprobe${suffix}@example.test`
  const username = `manager_${suffix}`
  const displayName = `Trigger Probe ${suffix}`
  let userId = null

  try {
    const signup = await jsonResponse(await fetch(`${apiUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: `Probe-${suffix}-Aa1!`,
        data: { username, display_name: displayName },
      }),
    }), 'auth signup')
    userId = signup?.user?.id ?? signup?.id ?? null
    if (!userId) throw new Error('auth signup did not return a user id')

    const rows = await jsonResponse(await fetch(
      `${apiUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,username,display_name`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      },
    ), 'profile lookup')
    const profile = Array.isArray(rows) ? rows[0] : null
    if (!profile) throw new Error(`signup trigger did not create profile ${userId}`)
    if (profile.username !== username || profile.display_name !== displayName) {
      throw new Error(`signup trigger metadata mismatch: ${JSON.stringify({
        expected: { username, display_name: displayName },
        actual: profile,
      })}`)
    }
    return { userId, username, displayName }
  } finally {
    if (userId) {
      await fetch(`${apiUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      }).catch(() => {})
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runSignupProfileTriggerProbe()
  console.log('Signup profile trigger probe passed.')
}

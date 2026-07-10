import { createClient } from '@supabase/supabase-js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

export const backendUrl = (env, pathname) => {
  const base = env.apiBaseUrl.endsWith('/') ? env.apiBaseUrl : `${env.apiBaseUrl}/`
  return new URL(pathname.replace(/^\/+/, ''), base).toString()
}

export const backendJson = async (env, pathname, body = {}) => {
  const response = await fetch(backendUrl(env, pathname), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-e2e-secret': env.e2eAdminSecret,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`)
  return response.json()
}

export const backendGetJson = async (env, pathname) => {
  const response = await fetch(backendUrl(env, pathname), {
    headers: { 'x-e2e-secret': env.e2eAdminSecret },
  })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`)
  return response.json()
}

export const backendAuthedJson = async (env, pathname, token, body = {}) => {
  const response = await fetch(backendUrl(env, pathname), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${pathname} returned ${response.status}${text ? `: ${text}` : ''}`)
  }
  return response.json()
}

export const assertBackendUsesFakePush = async (env, fakePort) => {
  const status = await backendGetJson(env, '/e2e/status')
  const expected = `http://127.0.0.1:${fakePort}/--/api/v2/push/send`
  if (status.expoPushUrl !== expected) {
    throw new Error(`D.X.1: backend EXPO_PUSH_URL is ${status.expoPushUrl ?? '<unset>'}; expected ${expected}`)
  }
}

export const signInForAccessToken = async (env, email, password, label = 'E2E sign-in') => {
  if (!env.anonKey) {
    throw new Error(
      'E2E authenticated Edge API scenarios require E2E_SUPABASE_PUBLISHABLE_KEY or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    )
  }
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (!error) {
      const token = data.session?.access_token
      if (!token) throw new Error(`${label} for ${email} returned no access token`)
      return token
    }
    lastError = error
    if (!/rate limit/i.test(error.message) || attempt === 4) break
    await sleep((attempt + 1) * 5000)
  }
  throw new Error(`${label} failed for ${email}: ${lastError?.message ?? 'unknown error'}`)
}

export const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })


const isTransientSupabaseError = (error) => {
  const message = String(error?.message ?? error ?? '')
  return /connection timeout|disconnect\/reset|upstream connect|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(message)
}

export const withSupabaseRetry = async (label, operation, attempts = 3) => {
  let latest
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = await operation()
    if (!latest?.error || !isTransientSupabaseError(latest.error) || attempt === attempts) return latest
    await sleep(250 * attempt)
  }
  return latest
}

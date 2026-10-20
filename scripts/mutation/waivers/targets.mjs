function localTarget(value, expectedPort, protocols) {
  const url = new URL(value ?? '')
  if (!/^[1-9]\d{0,4}$/.test(expectedPort) || Number(expectedPort) > 65535
    || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== expectedPort
    || !protocols.includes(url.protocol)) {
    throw new Error(`Refuse a target outside loopback port ${expectedPort}`)
  }
  return url
}

export function databaseTarget(env = process.env) {
  return localTarget(env.SUPABASE_DB_URL, env.PANCAKE_TEST_DB_PORT ?? '54322', ['postgres:', 'postgresql:'])
}

export function apiTarget(env = process.env) {
  return localTarget(env.E2E_SUPABASE_URL ?? env.SUPABASE_URL, env.PANCAKE_TEST_API_PORT ?? '54321', ['http:', 'https:'])
}

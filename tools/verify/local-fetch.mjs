export function localFixtureEnv(env) {
  return { ...env, PANCAKE_VERIFY_FIXTURE_LOCAL_TRANSPORT: '1', NODE_OPTIONS: `--import=${import.meta.url}` }
}

if (process.env.PANCAKE_VERIFY_FIXTURE_LOCAL_TRANSPORT === '1') {
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return original(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('connection', 'close')
    return original(input, { ...init, headers })
  }
}

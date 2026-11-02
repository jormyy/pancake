import assert from 'node:assert/strict'
import { command, delay } from './common.mjs'

export async function configurePool(stack, { connections = undefined, lifetimeSeconds = undefined, idleSeconds = undefined } = {}) {
  if (connections == null && lifetimeSeconds == null && idleSeconds == null) return null
  for (const value of [connections, lifetimeSeconds, idleSeconds].filter(value => value != null)) assert.ok(Number.isInteger(value) && value > 0)
  const name = `supabase_rest_${stack.project}`
  const owned = await stack.owned(name)
  const networks = Object.keys(owned.networks)
  assert.equal(networks.length, 1)
  const image = `${stack.project}-rest:local`
  const changes = []
  for (const [key, value] of Object.entries({ PGRST_DB_POOL: connections, PGRST_DB_POOL_MAX_LIFETIME: lifetimeSeconds, PGRST_DB_POOL_MAX_IDLETIME: idleSeconds })) if (value != null) changes.push('--change', `ENV ${key}=${value}`)
  await command('docker', ['commit', ...changes, name, image])
  await command('docker', ['rm', '-f', name])
  await command('docker', ['run', '-d', '--name', name, '--network', networks[0], '--label', `com.supabase.cli.project=${stack.project}`, image])
  stack.temporaryImages ??= []
  stack.temporaryImages.push(image)
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${stack.api}/rest/v1/`, { headers: { apikey: stack.keys.ANON_KEY } }).catch(() => null)
    if (response?.ok) return { connections: connections ?? null, lifetimeSeconds: lifetimeSeconds ?? null, idleSeconds: idleSeconds ?? null }
    await delay(500)
  }
  throw new Error('The configured local PostgREST pool does not start')
}

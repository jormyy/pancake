import assert from 'node:assert/strict'
import { config, assertTarget } from './common.mjs'

export function assertFetchTarget(value) {
  const url = new URL(value)
  assert.equal(url.username,'')
  assert.equal(url.password,'')
  const kind=Object.entries(config.ports).find(([,port])=>String(port)===url.port)?.[0]
  assertTarget(url.origin,kind)
  return url
}

import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const upstream = require('expo/metro-config').getDefaultConfig(process.cwd())
const { scopeWebModuleIds } = require('../scripts/scope-web-module-ids.js')
const createFactory = scopeWebModuleIds(upstream.serializer.createModuleIdFactory)
const client = { platform: 'web', environment: 'client' }
const server = { platform: 'web', environment: 'node' }

describe('web module ID isolation', () => {
  it('keeps browser IDs stable when server serialization wins the race', () => {
    const build = (factory: typeof createFactory, serverFirst: boolean) => {
      const id = factory()
      if (serverFirst) {
        id('/server/entry.js', server)
        id('/shared/react.js', server)
      }
      return [id('/client/entry.js', client), id('/shared/react.js', client)]
    }
    expect(build(upstream.serializer.createModuleIdFactory, true)).not.toEqual(build(upstream.serializer.createModuleIdFactory, false))
    expect(build(createFactory, true)).toEqual(build(createFactory, false))
  })

  it('preserves both graphs under alternating serialization and repeated imports', () => {
    const id = createFactory()
    const browserOnly = upstream.serializer.createModuleIdFactory()
    const serverOnly = upstream.serializer.createModuleIdFactory()
    const serverModules = ['/server.js', '/shared/react.js', '/server-lazy.js', '/shared/react.js']
    const clientModules = ['/client.js', '/shared/react.js', '/client-lazy.js', '/shared/react.js']
    for (let index = 0; index < serverModules.length; index += 1) {
      expect(id(serverModules[index], server)).toBe(serverOnly(serverModules[index]))
      expect(id(clientModules[index], client)).toBe(browserOnly(clientModules[index]))
    }
  })

  it('keeps unscoped and native calls on the original factory', () => {
    const id = createFactory()
    const original = upstream.serializer.createModuleIdFactory()
    expect(id('/entry.js')).toBe(original('/entry.js'))
    expect(id('/native.js', { platform: 'ios' })).toBe(original('/native.js'))
    expect(id('/entry.js', { platform: 'android' })).toBe(original('/entry.js'))
    expect(id('/web.js', client)).toBe(0)
    expect(id('/native-next.js', { platform: 'ios' })).toBe(original('/native-next.js'))
  })

  it('preserves development reload IDs and isolates production exports', () => {
    const configPath = require.resolve('../metro.config.js')
    try {
      for (const mode of ['development', 'production']) {
        vi.stubEnv('NODE_ENV', mode)
        delete require.cache[configPath]
        const id = require(configPath).serializer.createModuleIdFactory()
        id('/server.js', server)
        const browserId = id('/client.js', client)
        if (mode === 'development') {
          expect(browserId).toBe(1)
          // Metro's HMR server requests IDs without the serializer context.
          expect(id('/client.js')).toBe(browserId)
        } else {
          expect(browserId).toBe(0)
        }
      }
    } finally {
      vi.unstubAllEnvs()
      delete require.cache[configPath]
    }
  })
})

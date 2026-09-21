import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const config = require('../metro.config.js')
const upstream = require('expo/metro-config').getDefaultConfig(process.cwd())
const client = { platform: 'web', environment: 'client' }
const server = { platform: 'web', environment: 'node' }

describe('web module ID isolation', () => {
  it('keeps browser IDs stable when server serialization wins the race', () => {
    const build = (factory: typeof config.serializer.createModuleIdFactory, serverFirst: boolean) => {
      const id = factory()
      if (serverFirst) {
        id('/server/entry.js', server)
        id('/shared/react.js', server)
      }
      return [id('/client/entry.js', client), id('/shared/react.js', client)]
    }
    expect(build(upstream.serializer.createModuleIdFactory, true)).not.toEqual(build(upstream.serializer.createModuleIdFactory, false))
    expect(build(config.serializer.createModuleIdFactory, true)).toEqual(build(config.serializer.createModuleIdFactory, false))
  })

  it('preserves both graphs under alternating serialization and repeated imports', () => {
    const id = config.serializer.createModuleIdFactory()
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
    const id = config.serializer.createModuleIdFactory()
    const original = upstream.serializer.createModuleIdFactory()
    expect(id('/entry.js')).toBe(original('/entry.js'))
    expect(id('/native.js', { platform: 'ios' })).toBe(original('/native.js'))
    expect(id('/entry.js', { platform: 'android' })).toBe(original('/entry.js'))
    expect(id('/web.js', client)).toBe(0)
    expect(id('/native-next.js', { platform: 'ios' })).toBe(original('/native-next.js'))
  })
})

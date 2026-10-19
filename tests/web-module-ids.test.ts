import { createRequire } from 'node:module'
import path from 'node:path'
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

describe('web icon subset validation', () => {
  const configPath = require.resolve('../metro.config.js')
  const iconRoot = path.join(path.dirname(require.resolve('@expo/vector-icons/package.json')), 'build/vendor/react-native-vector-icons')
  const fontPath = path.join(iconRoot, 'Fonts/MaterialIcons.ttf')
  const glyphPath = path.join(iconRoot, 'glyphmaps/MaterialIcons.json')
  const shippedGlyphs = require('../assets/fonts/MaterialIcons.glyphs.json')
  const collector = require('../assets/fonts/collect-icons.js')
  const context = {
    resolveRequest: (_context: unknown, filePath: string) => ({ type: 'sourceFile', filePath }),
  }

  it('defers the source scan until web icons resolve and reuses successful validation', () => {
    const scan = vi.spyOn(collector, 'collectMaterialIconNames').mockReturnValue({ menu: shippedGlyphs.menu })
    delete require.cache[configPath]
    try {
      const resolve = require(configPath).resolver.resolveRequest
      expect(scan).not.toHaveBeenCalled()
      expect(resolve(context, fontPath, 'ios')).toEqual({ type: 'sourceFile', filePath: fontPath })
      expect(resolve(context, glyphPath, 'android')).toEqual({ type: 'sourceFile', filePath: glyphPath })
      expect(resolve(context, '/ordinary.js', 'web')).toEqual({ type: 'sourceFile', filePath: '/ordinary.js' })
      expect(scan).not.toHaveBeenCalled()
      expect(resolve(context, fontPath, 'web')).toEqual({
        type: 'assetFiles', filePaths: [path.resolve('assets/fonts/MaterialIcons.woff2')],
      })
      expect(resolve(context, glyphPath, 'web')).toEqual({
        type: 'sourceFile', filePath: path.resolve('assets/fonts/MaterialIcons.glyphs.json'),
      })
      expect(scan).toHaveBeenCalledExactlyOnceWith(process.cwd())
    } finally {
      scan.mockRestore()
      delete require.cache[configPath]
    }
  })

  it.each([fontPath, glyphPath])('rejects an incomplete subset before substituting %s', (filePath) => {
    const scan = vi.spyOn(collector, 'collectMaterialIconNames').mockReturnValue({ menu: shippedGlyphs.menu + 1 })
    delete require.cache[configPath]
    try {
      const resolve = require(configPath).resolver.resolveRequest
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => resolve(context, filePath, 'web')).toThrow('MaterialIcons subset is missing menu.')
      }
      expect(scan).toHaveBeenCalledTimes(2)
    } finally {
      scan.mockRestore()
      delete require.cache[configPath]
    }
  })
})

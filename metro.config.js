const path = require('node:path')
const { readFileSync, readdirSync } = require('node:fs')
const { getDefaultConfig } = require('expo/metro-config')
const { scopeWebModuleIds } = require('./scripts/scope-web-module-ids.js')

const config = getDefaultConfig(__dirname)
config.resolver.assetExts = [...config.resolver.assetExts, 'woff2']
config.transformer.babelTransformerPath = require.resolve('./scripts/stable-css-transformer.js')
if (process.env.NODE_ENV === 'production') {
  config.serializer.createModuleIdFactory = scopeWebModuleIds(config.serializer.createModuleIdFactory)
}

const iconPackage = path.dirname(require.resolve('@expo/vector-icons/package.json'))
const iconRoot = path.join(iconPackage, 'build/vendor/react-native-vector-icons')
const outfitRoot = path.dirname(require.resolve('@expo-google-fonts/outfit/package.json'))
const outfitFiles = new Map(['500Medium', '600SemiBold', '700Bold'].map(weight => [
  path.join(outfitRoot, weight, `Outfit_${weight}.ttf`),
  path.join(__dirname, `assets/fonts/Outfit_${weight}.woff2`),
]))
const availableGlyphs = require(path.join(iconRoot, 'glyphmaps/MaterialIcons.json'))
const shippedGlyphs = require('./assets/fonts/MaterialIcons.glyphs.json')
const scanGlyphs = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) scanGlyphs(file)
    else if (/\.tsx?$/.test(entry.name)) {
      for (const [, , name] of readFileSync(file, 'utf8').matchAll(/(['"])([a-zA-Z0-9_-]+)\1/g)) {
        if (availableGlyphs[name] !== undefined && shippedGlyphs[name] !== availableGlyphs[name]) {
          throw new Error(`MaterialIcons subset is missing ${name}. Regenerate assets/fonts using assets/fonts/README.md.`)
        }
      }
    }
  }
}
for (const directory of ['app', 'components', 'constants', 'hooks', 'lib', 'contexts']) scanGlyphs(path.join(__dirname, directory))

const previousResolver = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'react-native-url-polyfill/auto') return { type: 'empty' }
  const resolved = (previousResolver ?? context.resolveRequest)(context, moduleName, platform)
  if (platform !== 'web' || resolved.type !== 'sourceFile' && resolved.type !== 'assetFiles') return resolved
  const source = resolved.filePath ?? resolved.filePaths?.[0]
  if (outfitFiles.has(source)) return { type: 'assetFiles', filePaths: [outfitFiles.get(source)] }
  if (source === path.join(iconRoot, 'Fonts/MaterialIcons.ttf')) {
    return { type: 'assetFiles', filePaths: [path.join(__dirname, 'assets/fonts/MaterialIcons.woff2')] }
  }
  if (source === path.join(iconRoot, 'glyphmaps/MaterialIcons.json')) {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'assets/fonts/MaterialIcons.glyphs.json') }
  }
  return resolved
}

module.exports = config

const { getDefaultConfig } = require('expo/metro-config')
const { scopeWebModuleIds } = require('./scripts/scope-web-module-ids.js')

const config = getDefaultConfig(__dirname)
config.transformer.babelTransformerPath = require.resolve('./scripts/stable-css-transformer.js')
config.serializer.createModuleIdFactory = scopeWebModuleIds(config.serializer.createModuleIdFactory)

module.exports = config

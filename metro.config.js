const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.transformer.babelTransformerPath = require.resolve('./scripts/stable-css-transformer.js')

module.exports = config

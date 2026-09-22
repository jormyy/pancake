const upstream = require('@expo/metro-config/babel-transformer')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')

module.exports.getCacheKey = () => {
  const hash = createHash('sha256')
  for (const file of [
    '@expo/metro-config/babel-transformer',
    '@expo/metro-config/build/babel-transformer',
    '@expo/metro-config/package.json',
  ]) hash.update(readFileSync(require.resolve(file))).update('\0')
  return hash.update(upstream.getCacheKey?.() ?? '').digest('hex')
}

// Lightning CSS exports an unordered map. Expo serializes its iteration order
// into JS, so identical CSS can produce different chunk and release digests.
const stableCssExports = () => ({
  visitor: {
    AssignmentExpression({ node }) {
      if (node.left.type !== 'MemberExpression' || node.left.object.name !== 'module' ||
          node.left.property.name !== 'exports') return
      const call = node.right
      if (call.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' ||
          call.callee.object.name !== 'Object' || call.callee.property.name !== 'assign') return
      if (call.arguments.length !== 3) throw new Error('Unexpected generated CSS export map')
      for (const argument of call.arguments) sortMap(argument)
      const native = call.arguments[1].properties.find((property) => key(property) === 'unstable_styles')
      if (!native) throw new Error('Unexpected generated CSS export map')
      sortMap(native.value)
    },
  },
})

const key = (property) => property.key.name ?? property.key.value

const sortMap = (node) => {
  if (node.type !== 'ObjectExpression' || node.properties.some((property) => (
    property.type !== 'ObjectProperty' || property.computed ||
    !['StringLiteral', 'Identifier'].includes(property.key.type)
  ))) throw new Error('Unexpected generated CSS export map')
  node.properties.sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0)
}

module.exports.transform = (props) => upstream.transform({
  ...props,
  plugins: /\.module(?:\.(?:native|ios|android|web))?\.(?:css|s[ac]ss)$/.test(props.filename)
    ? [...(props.plugins ?? []), stableCssExports]
    : props.plugins,
})

const path = require('node:path')

const appRoots = new Set(['app', 'components', 'constants', 'contexts', 'hooks', 'lib'])
const message = 'Edge/Vercel code may import only supabase/functions/_shared or generated core/cjs; run npm run generate:edge-shared. `{{source}}` does not resolve in the Supabase Edge bundler or Vercel Node.'

function crossesRuntime(source, filename, root) {
    if (source === '@pancake/core' || source.startsWith('@pancake/') || source.startsWith('@/')) return true
    if (!source.startsWith('.')) return false
    const target = path.relative(root, path.resolve(path.dirname(filename), source))
    return appRoots.has(target.split(path.sep)[0])
}

module.exports = {
    meta: {
        type: 'problem',
        messages: { crossesRuntime: message },
        schema: [],
    },
    create(context) {
        const root = context.cwd
        const check = (node, sourceNode) => {
            if (!sourceNode || typeof sourceNode.value !== 'string') return
            if (node.importKind === 'type' || node.exportKind === 'type') return
            if (crossesRuntime(sourceNode.value, context.filename, root)) {
                context.report({ node: sourceNode, messageId: 'crossesRuntime', data: { source: sourceNode.value } })
            }
        }
        return {
            ImportDeclaration: node => check(node, node.source),
            ExportNamedDeclaration: node => check(node, node.source),
            ExportAllDeclaration: node => check(node, node.source),
            ImportExpression: node => check(node, node.source),
        }
    },
}

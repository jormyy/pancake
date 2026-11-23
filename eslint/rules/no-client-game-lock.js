const message = 'Read the lock from the server: roster_players.locked_until_slate_end (lib/roster-locks) or a view lock field. The DB owns game locks in private.player_game_started.'
const lockColumns = /\b(status|game_time|started_at)\b|\*/
const lockFilters = /^(status|game_time|started_at)$/
const filterMethods = new Set(['eq', 'neq', 'in', 'lt', 'lte', 'gt', 'gte', 'is', 'not', 'filter'])
const timeFields = new Set(['game_time', 'started_at'])
const comparisons = new Set(['<', '<=', '>', '>='])

const stringValue = (node) => {
    if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
    if (node?.type === 'TemplateLiteral') return node.quasis.map(quasi => quasi.value.cooked).join('')
    return null
}

const readsNbaGames = (node) => {
    for (let current = node; current;) {
        if (current.type === 'CallExpression') {
            if (current.callee.type === 'MemberExpression' && current.callee.property.name === 'from' &&
                stringValue(current.arguments[0]) === 'nba_games') return true
            current = current.callee
        } else if (current.type === 'MemberExpression') current = current.object
        else if (current.type === 'AwaitExpression') current = current.argument
        else return false
    }
    return false
}

const readsTimeField = (node) => {
    if (!node || typeof node !== 'object') return false
    if (node.type === 'MemberExpression' && !node.computed && timeFields.has(node.property.name)) return true
    return Object.entries(node).some(([key, value]) => key !== 'parent' &&
        (Array.isArray(value) ? value.some(readsTimeField) : value && typeof value.type === 'string' && readsTimeField(value)))
}

module.exports = {
    meta: { type: 'problem', schema: [], messages: { gameLock: message } },
    create(context) {
        return {
            CallExpression(node) {
                if (node.callee.type !== 'MemberExpression') return
                const method = node.callee.property.name
                const columns = stringValue(node.arguments[0])
                const reads = method === 'select' ? columns !== null && lockColumns.test(columns)
                    : filterMethods.has(method) && columns !== null && lockFilters.test(columns)
                if (reads && readsNbaGames(node.callee.object)) context.report({ node, messageId: 'gameLock' })
            },
            BinaryExpression(node) {
                if (comparisons.has(node.operator) && (readsTimeField(node.left) || readsTimeField(node.right))) {
                    context.report({ node, messageId: 'gameLock' })
                }
            },
        }
    },
}

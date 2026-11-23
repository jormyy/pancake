const message = 'Use todayET()/toETDate() from core/src/dates (or todayLeague() from lib/timezone for a league-local day); game_date is the Eastern NBA day, never the UTC or device day (1364d50a, 2619847c).'

const DAY_SLICERS = new Set(['slice', 'substring', 'substr', 'split'])
const CALENDAR_GETTERS = new Set(['getFullYear', 'getMonth', 'getDate', 'getDay', 'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay'])
const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'])

const isDateNow = (node) => node?.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Date'
    && node.callee.property.type === 'Identifier' && node.callee.property.name === 'now'

const containsDateNow = (node) => {
    if (!node || typeof node.type !== 'string') return false
    if (isDateNow(node)) return true
    if (node.type === 'BinaryExpression') return containsDateNow(node.left) || containsDateNow(node.right)
    if (WRAPPERS.has(node.type)) return containsDateNow(node.expression)
    return false
}

const unwrap = (node) => (node && WRAPPERS.has(node.type) ? unwrap(node.expression) : node)

const isWallClockConstruction = (node) => {
    const value = unwrap(node)
    return value?.type === 'NewExpression'
        && value.callee.type === 'Identifier' && value.callee.name === 'Date'
        && (value.arguments.length === 0 || containsDateNow(value.arguments[0]))
}

function resolvesToWallClock(node, sourceCode) {
    const value = unwrap(node)
    if (isWallClockConstruction(value)) return true
    if (value?.type !== 'Identifier') return false
    for (let scope = sourceCode.getScope(value); scope; scope = scope.upper) {
        const variable = scope.set.get(value.name)
        if (!variable) continue
        const def = variable.defs[0]
        return def?.type === 'Variable' && def.parent.kind === 'const' && isWallClockConstruction(def.node.init)
    }
    return false
}

const memberName = (node) => (node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? node.property.name : null)

module.exports = {
    meta: {
        type: 'problem',
        docs: { description: 'Ban deriving a calendar day from the UTC or device clock outside core/src/dates.' },
        schema: [],
        messages: { easternDay: message },
    },
    create(context) {
        const sourceCode = context.sourceCode
        return {
            CallExpression(node) {
                const name = memberName(node.callee)
                if (!name) return
                const target = unwrap(node.callee.object)
                if (CALENDAR_GETTERS.has(name)) {
                    if (resolvesToWallClock(target, sourceCode)) context.report({ node, messageId: 'easternDay' })
                    return
                }
                if (!DAY_SLICERS.has(name) || target.type !== 'CallExpression') return
                const inner = memberName(target.callee)
                if ((inner === 'toISOString' || inner === 'toJSON') && resolvesToWallClock(target.callee.object, sourceCode)) {
                    context.report({ node, messageId: 'easternDay' })
                }
            },
        }
    },
}

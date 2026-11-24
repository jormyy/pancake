const MESSAGE = 'Use gamePhase() or gameAvailable() from core/src/live/phase; status never holds Postponed, and postponed, cancelled and suspended games are marked in game_status_text.'
const UNAVAILABLE_PATTERN = /postpon|ppd|cancel|suspend/i
const GAME_PATTERN = /postpon|ppd/i
const UNAVAILABLE_STATUS = /^(Postponed|Cancelled|Canceled|Suspended|PPD)$/

const propertyName = (node) => {
    if (node?.type !== 'MemberExpression') return null
    if (!node.computed && node.property.type === 'Identifier') return node.property.name
    if (node.property.type === 'Literal') return String(node.property.value)
    return null
}

const unwrap = (node) => node?.type === 'ChainExpression' ? node.expression : node

const isMember = (node, name) => propertyName(unwrap(node)) === name

const isNullish = (node) => node?.type === 'Literal' && node.value === null || node?.type === 'Identifier' && node.name === 'undefined'

const isUnavailableStatus = (node) => node?.type === 'Literal' && typeof node.value === 'string' && UNAVAILABLE_STATUS.test(node.value)

module.exports = {
    meta: {
        type: 'problem',
        docs: { description: 'Decide game availability and phase only in core/src/live/phase.' },
        schema: [],
        messages: { phase: MESSAGE },
    },
    create(context) {
        const report = (node) => context.report({ node, messageId: 'phase' })
        return {
            Literal(node) {
                if (!node.regex || !UNAVAILABLE_PATTERN.test(node.regex.pattern)) return
                const call = node.parent?.type === 'MemberExpression' ? node.parent.parent : node.parent
                if (GAME_PATTERN.test(node.regex.pattern) || call?.type === 'CallExpression' && /status/i.test(context.sourceCode.getText(call))) report(node)
            },
            BinaryExpression(node) {
                if (!['===', '!==', '==', '!='].includes(node.operator)) return
                const sides = [node.left, node.right]
                if (sides.some(side => isMember(side, 'status')) && sides.some(isUnavailableStatus)) report(node)
                if (sides.some(side => isMember(side, 'stats_synced_at')) && sides.some(isNullish)) report(node)
            },
            UnaryExpression(node) {
                if (node.operator === '!' && isMember(node.argument, 'stats_synced_at')) report(node)
            },
            CallExpression(node) {
                const callee = unwrap(node.callee)
                if (propertyName(callee) !== 'includes' || callee.object.type !== 'ArrayExpression') return
                if (callee.object.elements.some(isUnavailableStatus) && node.arguments.some(argument => isMember(argument, 'status'))) report(node)
            },
            Property(node) {
                if ((node.key.name ?? node.key.value) === 'status' && isUnavailableStatus(node.value)) report(node)
            },
        }
    },
}

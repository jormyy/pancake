const seasonYearName = /^(season_?year|[a-z_]*Season_?Year)$/i

const operandName = (node) => {
    if (node.type === 'ChainExpression') return operandName(node.expression)
    if (node.type === 'BinaryExpression' && (node.operator === '+' || node.operator === '-')) return operandName(node.left)
    if (node.type === 'Identifier') return node.name
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return node.property.name
    if (node.type === 'MemberExpression' && node.computed && node.property.type === 'Literal') return String(node.property.value)
    return null
}

const isOne = (node) => node.type === 'Literal' && node.value === 1

module.exports = {
    meta: {
        type: 'problem',
        docs: { description: 'Convert league season years to draft years only through lib/picks' },
        schema: [],
        messages: {
            offset: 'Use draftYearForSeason or lastFutureDraftYear from lib/picks instead of season year {{operator}} 1; inline offsets put pick years one year off in 57aa5917 and 8a8ed53b.',
        },
    },
    create(context) {
        return {
            BinaryExpression(node) {
                if (node.operator !== '+' && node.operator !== '-') return
                const year = isOne(node.right) ? node.left : isOne(node.left) ? node.right : null
                const name = year && operandName(year)
                if (name && seasonYearName.test(name)) context.report({ node, messageId: 'offset', data: { operator: node.operator } })
            },
        }
    },
}

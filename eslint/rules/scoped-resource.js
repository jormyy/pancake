const fenceWords = new Set(['seq', 'sequence', 'gen', 'generation', 'epoch', 'request', 'requestid'])
const fencePhrases = ['stillValid', 'validatedKey']

function isFenceWord(name) {
    return name.split(/(?=[A-Z])|_/).some(word => fenceWords.has(word.toLowerCase()))
}

const setterMessage = 'State set after await can land on a newer league, member or account. Take a ticket from useScope (hooks/use-scope) before the await and set state inside ticket.commit(() => ...).'
const fenceMessage = 'Hand-rolled request fences get skipped on new paths. Use useScope (hooks/use-scope): scope.latest() supersedes older loads and ticket.commit drops work once the scope moves.'

function isFunction(node) {
    return node && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')
}

function settersOf(scopeManagerScope) {
    const setters = new Set()
    for (const variable of scopeManagerScope.variables) {
        const def = variable.defs[0]
        if (!def || def.type !== 'Variable') continue
        const declarator = def.node
        if (declarator.id.type !== 'ArrayPattern' || declarator.id.elements[1]?.type !== 'Identifier') continue
        if (declarator.id.elements[1].name !== variable.name) continue
        const init = declarator.init
        const callee = init?.type === 'CallExpression' ? init.callee : null
        const name = callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression' ? callee.property.name : null
        if (name === 'useState') setters.add(variable)
    }
    return setters
}

module.exports = {
    meta: { type: 'problem', schema: [], messages: { setter: setterMessage, fence: fenceMessage } },
    create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode()
        const awaitsByFunction = new Map()
        const pendingCalls = []

        function enclosingFunction(node) {
            for (let current = node.parent; current; current = current.parent) if (isFunction(current)) return current
            return null
        }

        function isPromiseCallback(fn) {
            const parent = fn.parent
            return parent?.type === 'CallExpression' && parent.arguments.includes(fn)
                && parent.callee.type === 'MemberExpression' && ['then', 'catch', 'finally'].includes(parent.callee.property.name)
        }

        return {
            AwaitExpression(node) {
                const fn = enclosingFunction(node)
                if (!fn) return
                const list = awaitsByFunction.get(fn) ?? []
                list.push(node.range[0])
                awaitsByFunction.set(fn, list)
            },
            ForOfStatement(node) {
                if (!node.await) return
                const fn = enclosingFunction(node)
                if (!fn) return
                const list = awaitsByFunction.get(fn) ?? []
                list.push(node.range[0])
                awaitsByFunction.set(fn, list)
            },
            CallExpression(node) {
                if (node.callee.type !== 'Identifier') return
                pendingCalls.push(node)
            },
            VariableDeclarator(node) {
                if (node.id.type !== 'Identifier') return
                const name = node.id.name
                const init = node.init
                const counter = init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'useRef' && isFenceWord(name)
                if (counter || fencePhrases.some(phrase => name.includes(phrase))) context.report({ node: node.id, messageId: 'fence' })
            },
            'Program:exit'() {
                const setterCache = new Map()
                for (const call of pendingCalls) {
                    const fn = enclosingFunction(call)
                    if (!fn) continue
                    const awaits = awaitsByFunction.get(fn)
                    const afterAwait = awaits?.some(position => position < call.range[0])
                    if (!afterAwait && !isPromiseCallback(fn)) continue
                    const reference = sourceCode.getScope(call).references.find(ref => ref.identifier === call.callee)
                    const variable = reference?.resolved
                    if (!variable) continue
                    let setters = setterCache.get(variable.scope)
                    if (!setters) { setters = settersOf(variable.scope); setterCache.set(variable.scope, setters) }
                    if (setters.has(variable)) context.report({ node: call, messageId: 'setter' })
                }
            },
        }
    },
}

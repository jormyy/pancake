const lifecycleEvents = new Set(['online', 'offline', 'visibilitychange', 'focus', 'pageshow'])
const browserTargets = new Set(['window', 'document', 'globalThis', 'self'])

const listenerMessage = "Hand-wired '{{event}}' listeners get skipped by the next resource, so it shows pre-sleep data. Use onLifecycle from lib/lifecycle, or read through useFocusAsyncData or useScreenView, which revalidate on reconnect, foreground and socket rejoin."
const appStateMessage = 'AppState listeners duplicate the browser lifecycle and miss reconnect and rejoin. Use onLifecycle from lib/lifecycle.'
const channelMessage = 'A raw supabase.channel stays dead after CLOSED and never refetches missed changes. Subscribe through subscribeToTableChanges in lib/realtime, which rebuilds closed channels and announces rejoin.'

function name(node) {
    if (!node) return null
    if (node.type === 'Identifier') return node.name
    if (node.type === 'Literal') return String(node.value)
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
    return null
}

function target(node) {
    if (node.type === 'Identifier') return node.name
    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && browserTargets.has(node.object.name)) return name(node.property)
    return null
}

module.exports = {
    meta: { type: 'problem', schema: [], messages: { listener: listenerMessage, appState: appStateMessage, channel: channelMessage } },
    create(context) {
        return {
            CallExpression(node) {
                const callee = node.callee
                if (callee.type !== 'MemberExpression') return
                const method = callee.computed ? name(callee.property) : callee.property.name
                const owner = target(callee.object)
                if (method === 'channel' && owner === 'supabase') {
                    context.report({ node, messageId: 'channel' })
                    return
                }
                if (method !== 'addEventListener') return
                if (owner === 'AppState') {
                    context.report({ node, messageId: 'appState' })
                    return
                }
                const event = name(node.arguments[0])
                if (event && lifecycleEvents.has(event) && owner && browserTargets.has(owner)) context.report({ node, messageId: 'listener', data: { event } })
            },
        }
    },
}

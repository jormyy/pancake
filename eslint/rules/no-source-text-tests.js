const HELPER_MESSAGE = 'Test imports the SQL text helper "{{path}}". Assert behavior through agent-browser e2e or a real-DB test; source-text tests broke on refactors in e3fc93e3/945f2849.'
const MESSAGE = 'Test asserts on the text of product source "{{path}}". Assert behavior through agent-browser e2e or a real-DB test; source-text tests broke on refactors in e3fc93e3/945f2849.'

const SOURCE_PATH = /^(?:\.{1,2}\/)*(?:app|components|hooks|contexts|constants|lib|types|core\/src|supabase\/(?:functions|sql|migrations))(?:\/|$)/
const READ_NAMES = new Set(['readFileSync', 'readFile', 'readTextFile', 'readTextFileSync'])
const READER_NAME = /^read(?!dir|link)\w*$/i
const SOURCE_TEXT_HELPER = /(^|\/)source-guard(\.ts)?$/
const PATH_BUILDERS = new Set(['join', 'resolve', 'URL'])
const TEXT_PROBES = new Set(['includes', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'search', 'startsWith', 'endsWith'])
const EXECUTORS = new Set(['runInNewContext', 'runInContext', 'runInThisContext', 'Script', 'Function', 'eval', 'transpileModule', 'transform', 'transformSync', 'compileFunction'])
const ASSERTION_ROOTS = new Set(['expect', 'assert'])

function calleeName(callee) {
    if (callee.type === 'Identifier') return callee.name
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name
    return null
}

function rootName(node) {
    let current = node
    while (current) {
        if (current.type === 'Identifier') return current.name
        if (current.type === 'MemberExpression') current = current.object
        else if (current.type === 'CallExpression') current = current.callee
        else return null
    }
    return null
}

function staticText(node) {
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value
    if (node.type === 'TemplateLiteral') return node.quasis.map(quasi => quasi.value.cooked).join('*')
    return null
}

function isRepoRoot(node) {
    if (node.type === 'Identifier') return node.name === '__dirname' || /root/i.test(node.name)
    if (node.type === 'CallExpression') return calleeName(node.callee) === 'cwd'
    if (node.type === 'MemberExpression') return calleeName(node) === 'url' || calleeName(node) === 'dirname'
    return false
}

function builtPath(node) {
    const parts = []
    for (const argument of node.arguments) {
        const text = staticText(argument)
        if (text !== null) parts.push(text)
        else if (parts.length > 0) parts.push('*')
        else if (!isRepoRoot(argument)) return null
    }
    return parts.join('/')
}

function sourcePath(node, lookup) {
    if (!node) return null
    const text = staticText(node)
    if (text !== null) return SOURCE_PATH.test(text) ? text : null
    if (node.type === 'Identifier') return lookup(node.name)
    if (node.type === 'BinaryExpression' && node.operator === '+') return sourcePath(node.left, lookup)
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && PATH_BUILDERS.has(calleeName(node.callee))) {
        const joined = builtPath(node)
        return joined !== null && SOURCE_PATH.test(joined) ? joined : null
    }
    return null
}

function literalSourcePath(node) {
    let found = null
    some(node, current => {
        const text = staticText(current)
        if (text !== null && SOURCE_PATH.test(text)) found = text
        return found !== null
    })
    return found
}

function children(node) {
    const result = []
    for (const key of Object.keys(node)) {
        if (key === 'parent') continue
        const value = node[key]
        if (Array.isArray(value)) value.forEach(item => item && typeof item.type === 'string' && result.push(item))
        else if (value && typeof value.type === 'string') result.push(value)
    }
    return result
}

function some(node, predicate) {
    if (!node || typeof node.type !== 'string') return false
    if (predicate(node)) return true
    return children(node).some(child => some(child, predicate))
}

function reaches(node, predicate) {
    if (!node || typeof node.type !== 'string') return false
    if (predicate(node)) return true
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && EXECUTORS.has(calleeName(node.callee))) return false
    return children(node).some(child => reaches(child, predicate))
}

function returnedValues(body) {
    if (body.type !== 'BlockStatement') return [body]
    const values = []
    const visit = node => {
        if (!node || typeof node.type !== 'string') return
        if (node.type === 'ReturnStatement' && node.argument) values.push(node.argument)
        if (node !== body && /Function/.test(node.type)) return
        children(node).forEach(visit)
    }
    visit(body)
    return values
}

function patternNames(pattern, names = []) {
    if (!pattern) return names
    if (pattern.type === 'Identifier') names.push(pattern.name)
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(property => patternNames(property.type === 'RestElement' ? property.argument : property.value, names))
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(element => patternNames(element, names))
    else if (pattern.type === 'RestElement') patternNames(pattern.argument, names)
    else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, names)
    return names
}

function isValueReference(node) {
    if (node.type !== 'Identifier') return false
    const parent = node.parent
    if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false
    if (parent && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return false
    return true
}

module.exports = {
    meta: {
        type: 'problem',
        docs: { description: 'Ban tests that assert on the text of app, lib or SQL source instead of on behavior.' },
        schema: [],
        messages: { sourceText: MESSAGE, sourceTextHelper: HELPER_MESSAGE },
    },
    create(context) {
        const readers = new Set(READ_NAMES)
        const isReader = name => readers.has(name) || READER_NAME.test(name ?? '')
        const calls = []
        const bindings = []
        const exported = new Set()

        return {
            CallExpression(node) {
                calls.push(node)
            },
            ImportDeclaration(node) {
                if (SOURCE_TEXT_HELPER.test(node.source.value)) context.report({ node: node.source, messageId: 'sourceTextHelper', data: { path: node.source.value } })
            },
            FunctionDeclaration(node) {
                if (node.id) bindings.push({ names: [node.id.name], value: node.body, isFunction: true })
            },
            VariableDeclarator(node) {
                if (!node.init) return
                const isFunction = node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression'
                bindings.push({ names: patternNames(node.id), value: isFunction ? node.init.body : node.init, isFunction })
            },
            AssignmentExpression(node) {
                bindings.push({ names: patternNames(node.left), value: node.right, isFunction: false })
            },
            ForOfStatement(node) {
                const target = node.left.type === 'VariableDeclaration' ? node.left.declarations[0].id : node.left
                bindings.push({ names: patternNames(target), value: node.right, isFunction: false })
            },
            ExportNamedDeclaration(node) {
                if (node.declaration && node.declaration.type === 'VariableDeclaration') node.declaration.declarations.forEach(declarator => patternNames(declarator.id).forEach(name => exported.add(name)))
                if (node.declaration && node.declaration.type === 'FunctionDeclaration' && node.declaration.id) exported.add(node.declaration.id.name)
                node.specifiers.forEach(specifier => specifier.local.type === 'Identifier' && exported.add(specifier.local.name))
            },
            'Program:exit'() {
                let grew = true
                while (grew) {
                    grew = false
                    for (const binding of bindings) {
                        if (!binding.isFunction) continue
                        const reads = some(binding.value, node => node.type === 'CallExpression' && readers.has(calleeName(node.callee)))
                        for (const name of binding.names) {
                            if (reads && !readers.has(name)) {
                                readers.add(name)
                                grew = true
                            }
                        }
                    }
                }

                const lookup = name => {
                    for (const binding of bindings) {
                        if (binding.isFunction || !binding.names.includes(name)) continue
                        const path = literalSourcePath(binding.value)
                        if (path) return path
                    }
                    return null
                }
                const sources = []
                for (const call of calls) {
                    if (!isReader(calleeName(call.callee))) continue
                    for (const argument of call.arguments) {
                        const path = sourcePath(argument, lookup)
                        if (path) sources.push({ call, argument, path })
                    }
                }

                const sinks = calls.filter(call => {
                    const root = rootName(call.callee)
                    return ASSERTION_ROOTS.has(root) || TEXT_PROBES.has(calleeName(call.callee))
                })

                for (const source of sources) {
                    const tainted = new Set()
                    const carries = root => reaches(root, node => node === source.call
                        || (isValueReference(node) && tainted.has(node.name))
                        || (node.type === 'CallExpression' && tainted.has(calleeName(node.callee))))
                    let spreading = true
                    while (spreading) {
                        spreading = false
                        for (const binding of bindings) {
                            const flows = binding.isFunction ? returnedValues(binding.value).some(carries) : carries(binding.value)
                            if (!flows) continue
                            for (const name of binding.names) {
                                if (!tainted.has(name)) {
                                    tainted.add(name)
                                    spreading = true
                                }
                            }
                        }
                    }
                    const asserted = sinks.some(carries)
                    const leaked = [...exported].some(name => tainted.has(name))
                    if (asserted || leaked) context.report({ node: source.argument, messageId: 'sourceText', data: { path: source.path } })
                }
            },
        }
    },
}

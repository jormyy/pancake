import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { maskSqlNonCode } from '../../scripts/check-db-function-sources.mjs'

const clientDirectories = ['app', 'components', 'constants', 'contexts', 'hooks', 'lib']

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name)
        return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(file) ? [file] : []
    })
}

type Binding = { expression: ts.Expression; bindings: Map<ts.Symbol, Binding> }

export function clientRealtimeTables(root = process.cwd(), files = clientDirectories.flatMap(directory => sourceFiles(path.join(root, directory)))) {
    const program = ts.createProgram(files, {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX, baseUrl: root, paths: { '@/*': ['./*'] }, skipLibCheck: true,
    })
    const checker = program.getTypeChecker()
    const tables = new Set<string>()
    const stack = new Set<ts.Node>()
    const resolve = (node: ts.Identifier) => {
        const symbol = checker.getSymbolAtLocation(node)
        return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    }
    function fail(node: ts.Node): never {
        throw new Error(`Cannot resolve realtime watch in ${path.relative(root, node.getSourceFile().fileName)}: ${node.getText()}`)
    }
    const returns = (body: ts.ConciseBody) => {
        const expressions: ts.Expression[] = []
        const visit = (node: ts.Node) => {
            if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression)
            else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit)
        }
        if (ts.isBlock(body)) visit(body)
        else expressions.push(body)
        return expressions
    }
    const collect = (expression: ts.Expression, bindings: Map<ts.Symbol, Binding>, tableName = false): void => {
        if (stack.has(expression)) fail(expression)
        stack.add(expression)
        try {
            if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
                collect(expression.expression, bindings, tableName)
            } else if (tableName && ts.isStringLiteralLike(expression)) {
                tables.add(expression.text)
            } else if (ts.isIdentifier(expression)) {
                const symbol = resolve(expression)
                const binding = symbol && bindings.get(symbol)
                const declaration = symbol?.valueDeclaration
                if (binding) collect(binding.expression, binding.bindings, tableName)
                else if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) collect(declaration.initializer, bindings, tableName)
                else fail(expression)
            } else if (!tableName && ts.isArrayLiteralExpression(expression)) {
                for (const entry of expression.elements) collect(ts.isSpreadElement(entry) ? entry.expression : entry, bindings)
            } else if (!tableName && ts.isObjectLiteralExpression(expression)) {
                const table = expression.properties.find(property => !ts.isSpreadAssignment(property) && property.name?.getText().replaceAll(/["']/g, '') === 'table')
                if (table && ts.isPropertyAssignment(table)) collect(table.initializer, bindings, true)
                else if (table && ts.isShorthandPropertyAssignment(table)) collect(table.name, bindings, true)
                else for (const property of expression.properties) if (ts.isSpreadAssignment(property)) collect(property.expression, bindings)
            } else if (!tableName && ts.isCallExpression(expression)) {
                if (ts.isPropertyAccessExpression(expression.expression) && ['map', 'flatMap'].includes(expression.expression.name.text)) {
                    const callback = expression.arguments[0]
                    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) fail(expression)
                    const next = new Map(bindings)
                    const parameter = callback.parameters[0]
                    const symbol = parameter && checker.getSymbolAtLocation(parameter.name)
                    if (symbol) next.set(symbol, { expression: expression.expression.expression, bindings })
                    for (const returned of returns(callback.body)) collect(returned, next)
                    return
                }
                const declaration = checker.getResolvedSignature(expression)?.declaration
                if (!declaration || !(ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) || !declaration.body) fail(expression)
                const next = new Map(bindings)
                for (const [index, parameter] of declaration.parameters.entries()) {
                    const symbol = checker.getSymbolAtLocation(parameter.name)
                    const argument = expression.arguments[index] ?? parameter.initializer
                    if (symbol && argument) next.set(symbol, { expression: argument, bindings })
                }
                for (const returned of returns(declaration.body as ts.ConciseBody)) collect(returned, next)
            } else fail(expression)
        } finally {
            stack.delete(expression)
        }
    }
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
            if (node.getSourceFile().fileName !== path.join(root, 'lib/realtime.ts')
                && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'on'
                && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'postgres_changes') {
                if (!node.arguments[1]) fail(node)
                collect(node.arguments[1], new Map())
            }
            const declaration = checker.getResolvedSignature(node)?.declaration
            if (declaration && ts.isFunctionDeclaration(declaration) && declaration.name?.text === 'subscribeToTableChanges'
                && declaration.getSourceFile().fileName === path.join(root, 'lib/realtime.ts')) {
                const options = node.arguments[1]
                if (!options || !ts.isObjectLiteralExpression(options)) fail(node)
                const watches = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText() === 'watches')
                if (!watches || !ts.isPropertyAssignment(watches)) fail(options)
                collect(watches.initializer, new Map())
            }
        }
        ts.forEachChild(node, visit)
    }
    for (const file of files) {
        const source = program.getSourceFile(file)
        if (source) visit(source)
    }
    if (!tables.size) throw new Error('No client realtime subscriptions found')
    return [...tables].sort()
}

export function publicationTables(migrations: string[]) {
    let tables: Set<string> | undefined
    for (const migration of migrations) {
        const source = maskSqlNonCode(migration)
        const statements = [...source.matchAll(/ALTER\s+PUBLICATION\s+supabase_realtime\s+(SET|ADD|DROP)\s+TABLE\s+([^;]+);/gi)]
        if (tables && [...migration.matchAll(/(?:ALTER|CREATE|DROP)\s+PUBLICATION\s+supabase_realtime\b/gi)].length > statements.length) {
            throw new Error('Cannot resolve a later realtime publication change')
        }
        for (const [, operation, list] of statements) {
            if (operation.toUpperCase() === 'SET') tables = new Set()
            if (!tables) continue
            for (const entry of list.split(',')) {
                const match = /^\s*(?:public\.)?([a-z_]+)\s*$/i.exec(entry)
                if (!match) throw new Error(`Unsupported realtime publication table: ${entry}`)
                if (operation.toUpperCase() === 'DROP') tables.delete(match[1])
                else tables.add(match[1])
            }
        }
    }
    if (!tables) throw new Error('No explicit realtime publication set found')
    return [...tables].sort()
}

export function repositoryPublicationTables() {
    return publicationTables(readdirSync('supabase/migrations').filter(file => /^\d+_.+\.sql$/.test(file)).sort()
        .map(file => readFileSync(path.join('supabase/migrations', file), 'utf8')))
}

export function publicationDifference(watched: string[], published: string[]) {
    return { missing: watched.filter(table => !published.includes(table)), unwatched: published.filter(table => !watched.includes(table)) }
}

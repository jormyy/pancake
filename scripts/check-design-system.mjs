import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const metricKind = name => name === 'fontSize' ? 'font' : name === 'lineHeight' ? 'lineHeight'
    : name === 'letterSpacing' ? 'tracking' : /^border.*Radius$/.test(name) ? 'radius'
        : /^(?:(?:padding|margin)(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?|gap|rowGap|columnGap|top|bottom|left|right|inset)$/.test(name) ? 'spacing' : null
const cssMetric = /\b(padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|row-gap|column-gap|font(?:-size)?|line-height|letter-spacing|border(?:-[a-z]+)?-radius|top|bottom|left|right)\s*:\s*([^;{}'"\n]+)/g
const rawColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color)\s*\(/i
const colorProperty = /(?:color|fill|stroke|background)$/i
const semanticColor = /^(?:inherit|initial|unset|revert|none|currentColor|var\(|url\()/i
const rawScale = new Set(['fontSize', 'lineHeight'])
const touchSize = new Set(['minHeight', 'minWidth', 'height', 'width'])
const TOUCH = 44

export function scanDesignSystem(source, file = 'app/fixture.tsx') {
    if (!/^(?:app|components)\//.test(file)) return []
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const violations = new Map()
    const bindings = new Map()
    const register = (node, kind, property, value = node.getText(tree), start = node.getStart(tree), end = node.end) => {
        const { line } = tree.getLineAndCharacterOfPosition(start)
        violations.set(`${start}:${end}`, { file, line: line + 1, kind, property, value, start, end })
    }
    const collect = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer)
        ts.forEachChild(node, collect)
    }
    collect(tree)
    const numbers = (node, kind, property, seen = new Set()) => {
        if (ts.isObjectLiteralExpression(node)) return
        if (ts.isConditionalExpression(node)) {
            numbers(node.whenTrue, kind, property, seen)
            numbers(node.whenFalse, kind, property, seen)
            return
        }
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return
        if (ts.isBinaryExpression(node) && ['<', '>', '<=', '>=', '===', '!==', '==', '!='].includes(node.operatorToken.getText(tree))) return
        if (ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
            if (ts.isBinaryExpression(node.parent) && [ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(node.parent.operatorToken.kind)) {
                const other = node.parent.left === node ? node.parent.right : node.parent.left
                if (!ts.isNumericLiteral(other) && !(ts.isPrefixUnaryExpression(other) && ts.isNumericLiteral(other.operand))) return
            }
            register(node, kind, property)
            return
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /(?:\d(?:px|rem|em|%)|^-?\d+(?:\.\d+)?$)/.test(node.text)) { register(node, kind, property); return }
        if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
            numbers(bindings.get(node.text), kind, property, new Set([...seen, node.text]))
            return
        }
        ts.forEachChild(node, child => numbers(child, kind, property, seen))
    }
    const visit = node => {
        if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@/constants/tokens' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
            for (const item of node.importClause.namedBindings.elements) {
                const imported = (item.propertyName ?? item.name).text
                if (rawScale.has(imported)) register(item, 'type', imported, imported)
            }
        }
        if (ts.isPropertyAssignment(node) || ts.isJsxAttribute(node)) {
            const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name
            const property = ts.isStringLiteralLike(name) ? name.text : name.getText(tree)
            const kind = metricKind(property)
            if (kind && node.initializer) numbers(node.initializer, kind, property)
            if (touchSize.has(property) && node.initializer) {
                const touch = child => {
                    if (ts.isConditionalExpression(child)) { touch(child.whenTrue); touch(child.whenFalse); return }
                    if (ts.isNumericLiteral(child) && Number(child.text) === TOUCH) register(child, 'touch', property)
                }
                touch(node.initializer)
            }
            if (colorProperty.test(property) && node.initializer) {
                const checkColor = (child, seen = new Set()) => {
                    if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) {
                        const object = ts.isIdentifier(child.expression) ? bindings.get(child.expression.text) : null
                        if (object && ts.isObjectLiteralExpression(object)) {
                            for (const item of object.properties) if (ts.isPropertyAssignment(item)) checkColor(item.initializer, seen)
                        }
                        return
                    }
                    if (ts.isConditionalExpression(child)) { checkColor(child.whenTrue, seen); checkColor(child.whenFalse, seen); return }
                    if (ts.isStringLiteralLike(child) && !semanticColor.test(child.text)) register(child, 'color', property)
                    if (ts.isIdentifier(child) && bindings.has(child.text) && !seen.has(child.text)) {
                        checkColor(bindings.get(child.text), new Set([...seen, child.text]))
                        return
                    }
                    ts.forEachChild(child, nested => checkColor(nested, seen))
                }
                checkColor(node.initializer)
            }
        }
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && rawColor.test(node.text)) register(node, 'color', 'color')
        if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
            const css = node.getText(tree).replace(/\$\{[^}]*\}/g, value => ' '.repeat(value.length))
            for (const match of css.matchAll(cssMetric)) {
                const property = match[1]
                for (const literal of match[2].matchAll(/(?<![\w.-])-?\d+(?:\.\d+)?(?:px|rem|em)?\b/g)) {
                    const start = node.getStart(tree) + match.index + match[0].indexOf(match[2]) + literal.index
                    register(node, 'css', property, literal[0], start, start + literal[0].length)
                }
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(tree)
    return [...violations.values()].sort((a, b) => a.start - b.start)
}

const INVENTORY = 'tests/ui/ui-inventory.json'
const KINDS = new Set(['route', 'tab', 'sheet', 'menu', 'form', 'dialog', 'toast', 'banner', 'shell', 'state', 'redirect'])
const SURFACE_TRIGGER = /<(?:Sheet|Modal|ModalScreen|PromptFrame|SegmentedControl|FilterSelect|MultiSelect|Input|TextInput|Switch|EmptyState|ErrorBanner|LoadingState|DeferredContent)\b|\b(?:confirmAction|confirmRosterActivation|showAlert|showSuccess)\(/

const listSources = (root, folders) => folders.flatMap(folder => readdirSync(path.join(root, folder), { recursive: true })
    .map(file => `${folder}/${String(file).split(path.sep).join('/')}`)).filter(file => /\.tsx?$/.test(file)).sort()

export const readInventory = (root = process.cwd()) => JSON.parse(readFileSync(path.join(root, INVENTORY), 'utf8'))

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:([\w\s{},*]+?)\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
const FEEDBACK_CALL = /\b(?:confirmAction|confirmRosterActivation|showAlert|showSuccess)\(/
const PRIMITIVE_DEPTH = 3

function resolveImport(root, from, specifier) {
    const base = specifier.startsWith('@/') ? specifier.slice(2) : specifier.startsWith('.') ? path.posix.join(path.posix.dirname(from), specifier) : null
    if (!base) return null
    return ['.web.tsx', '.tsx', '.ts', '/index.ts', '/index.tsx', ''].map(ext => base + ext).find(file => /\.tsx?$/.test(file) && existsSync(path.join(root, file))) ?? null
}

export function primitivesUsed(root, sources) {
    const used = new Set()
    const seen = new Set()
    const queue = sources.map(file => [file, 0])
    while (queue.length) {
        const [file, depth] = queue.pop()
        if (seen.has(file) || !existsSync(path.join(root, file))) continue
        seen.add(file)
        const source = readFileSync(path.join(root, file), 'utf8')
        if (depth === 0) for (const match of source.matchAll(/export (?:function|const|class) (\w+)/g)) used.add(match[1])
        if (FEEDBACK_CALL.test(source)) used.add('FeedbackProvider')
        for (const match of source.matchAll(IMPORT)) {
            const target = resolveImport(root, file, match[2] ?? match[3])
            if (!target?.startsWith('components/')) continue
            for (const name of (match[1] ?? '').matchAll(/\b[A-Z]\w*/g)) used.add(name[0])
            if (depth < PRIMITIVE_DEPTH) queue.push([target, depth + 1])
        }
    }
    return used
}

export function designSystemViolations(root = process.cwd(), inventory = readInventory(root)) {
    const allowed = new Map(inventory.exceptions.map(item => [`${item.file}|${item.property}|${item.value}`, item]))
    const used = new Set()
    const violations = listSources(root, ['app', 'components'])
        .flatMap(file => scanDesignSystem(readFileSync(path.join(root, file), 'utf8'), file))
        .filter(item => {
            const key = `${item.file}|${item.property}|${item.value}`
            if (!allowed.has(key)) return true
            used.add(key)
            return false
        })
    for (const [key, item] of allowed) {
        if (!item.reason?.trim()) violations.push({ file: item.file, line: 0, kind: 'exception', property: item.property, value: `${item.value} has no reason` })
        else if (!used.has(key)) violations.push({ file: item.file, line: 0, kind: 'exception', property: item.property, value: `${item.value} is a stale exception` })
    }
    return violations
}

export function inventoryViolations(root = process.cwd(), inventory = readInventory(root)) {
    const problems = []
    const roles = new Set(inventory.roles)
    const states = new Set(inventory.states)
    const exported = new Set(listSources(root, ['components']).flatMap(file => [...readFileSync(path.join(root, file), 'utf8')
        .matchAll(/export (?:function|const|class) (\w+)|export \{ ([^}]+) \}/g)].flatMap(match => match[1] ? [match[1]] : match[2].split(',').map(name => name.trim().split(/\s+as\s+/).pop()))))
    const ids = new Set()
    const covered = new Set()
    for (const surface of inventory.surfaces) {
        const where = surface.id ?? '(missing id)'
        if (!/^[a-z]+(?:\.[a-z0-9-]+)+$/.test(surface.id ?? '')) problems.push(`${where}: id must look like area.name`)
        if (ids.has(surface.id)) problems.push(`${where}: duplicate id`)
        ids.add(surface.id)
        if (!KINDS.has(surface.kind)) problems.push(`${where}: unknown kind ${surface.kind}`)
        for (const field of ['entry', 'goal', 'primaryAction']) if (!surface[field]?.trim()) problems.push(`${where}: missing ${field}`)
        if (!surface.roles?.length) problems.push(`${where}: needs at least one role`)
        for (const role of surface.roles ?? []) if (!roles.has(role)) problems.push(`${where}: unknown role ${role}`)
        if (!surface.states?.length) problems.push(`${where}: needs at least one state`)
        for (const state of surface.states ?? []) if (!states.has(state)) problems.push(`${where}: unknown state ${state}`)
        const unreachable = surface.states?.includes('unreachable')
        if (unreachable !== Boolean(surface.unreachable?.trim())) problems.push(`${where}: an unreachable surface needs its reason, and only then`)
        if (!unreachable && !surface.primitives?.length && !surface.nativeControl?.trim()) problems.push(`${where}: name the shared primitives it uses, or the reason it is a native control`)
        if (surface.nativeControl !== undefined && surface.primitives?.length) problems.push(`${where}: a native control lists no shared primitives`)
        for (const primitive of surface.primitives ?? []) if (!exported.has(primitive)) problems.push(`${where}: ${primitive} is not a shared component export`)
        const reached = primitivesUsed(root, surface.sources ?? [])
        for (const primitive of surface.primitives ?? []) if (exported.has(primitive) && !reached.has(primitive)) problems.push(`${where}: lists ${primitive} but its sources never use it`)
        if (!surface.sources?.length) problems.push(`${where}: needs at least one source file`)
        for (const source of surface.sources ?? []) {
            covered.add(source)
            if (!existsSync(path.join(root, source))) problems.push(`${where}: ${source} does not exist`)
        }
    }
    const routes = listSources(root, ['app']).filter(file => !/(?:^|\/)_layout(?:\.web)?\.tsx$/.test(file))
    const triggered = listSources(root, ['app', 'components', 'hooks', 'lib'])
        .filter(file => !file.startsWith('components/ui/') && SURFACE_TRIGGER.test(readFileSync(path.join(root, file), 'utf8')))
    for (const file of new Set([...routes, ...triggered])) if (!covered.has(file)) problems.push(`${file}: opens a screen, overlay, form, dialog or toast but no surface in ${INVENTORY} lists it`)
    return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const inventory = readInventory()
    const violations = designSystemViolations(process.cwd(), inventory)
    const coverage = inventoryViolations(process.cwd(), inventory)
    for (const item of violations) console.error(item.kind === 'type' ? `${item.file}:${item.line} ${item.value} is a raw type scale; use typeScale or textStyles` : `${item.file}:${item.line} ${item.property}: ${item.value} requires a shared token`)
    for (const problem of coverage) console.error(problem)
    if (violations.length || coverage.length) process.exitCode = 1
    else console.log(`Design system conformance passes for app/** and components/**; ${inventory.surfaces.length} surfaces cover every route and overlay`)
}
